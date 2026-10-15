import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { z } from 'zod';
import { can, type Capability } from '@feedbouncer/authz';
import type { Platform } from '@feedbouncer/connectors';
import { withTransaction } from '@feedbouncer/db';
import {
  MAX_ENABLED_POLICIES_PER_BRAND,
  MAX_POLICIES_PER_BRAND,
  POLICY_PREVIEW_JOB,
  POLICY_RUN_JOB,
  PgPolicyPreviewStore,
  PgPolicyStore,
  PgPolicyUsage,
  PolicyLimitError,
  PolicyNameTakenError,
  PreviewInProgressError,
  policyIssues,
  policyInputSchema,
  policyPatchSchema,
  previewRequestSchema,
  runRequestSchema,
  type PolicyUpdate,
  type PreviewView,
} from '@feedbouncer/policies';
import { errorFields } from '@feedbouncer/service-runtime';
import { recordAudit, type AuditInput } from '../audit/audit.js';
import { userNames } from '../classifier/classification.queries.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS, JOB_PRODUCER } from '../tokens.js';
import {
  toPolicyDto,
  toRevisionDto,
  type PolicyDetailDto,
  type PolicyDto,
  type PolicyListDto,
} from './policies.dto.js';

function parsePolicy<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const issues = policyIssues(r.error);
  throw new ApiError(400, 'invalid_policy', issues[0]?.message, { issues });
}

/** The store's patch type forbids explicit undefined, which the parsed schema may carry. */
const definedOnly = (patch: z.output<typeof policyPatchSchema>): PolicyUpdate => ({
  ...(patch.name !== undefined && { name: patch.name }),
  ...(patch.text !== undefined && { text: patch.text }),
  ...(patch.action !== undefined && { action: patch.action }),
  ...(patch.enabled !== undefined && { enabled: patch.enabled }),
});

const resetDay = (d: Date): string =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

@Injectable()
export class PoliciesService {
  readonly #store: PgPolicyStore;
  readonly #previews: PgPolicyPreviewStore;
  readonly #usage: PgPolicyUsage;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(JOB_PRODUCER) private readonly producer: AppDeps['producer'],
  ) {
    this.#store = new PgPolicyStore(deps.pool);
    this.#previews = new PgPolicyPreviewStore(deps.pool);
    this.#usage = new PgPolicyUsage(deps.pool);
  }

  /** Runs `fn` in a transaction after re-reading the actor's role under the organization lock. */
  #write<T>(org: OrgContext, cap: Capability, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, org), cap)) throw new ApiError(403, 'forbidden');
      return fn(c);
    });
  }

  #audit(
    c: pg.PoolClient,
    org: OrgContext,
    scope: BrandScope,
    e: Pick<AuditInput, 'action' | 'subjectType' | 'subjectId' | 'details'>,
  ): Promise<void> {
    return recordAudit(c, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      actorUserId: org.actorUserId,
      ...e,
    });
  }

  /** 503 when the deployment has no evaluation model, 429 when the month's budget is used. */
  async #ensureAvailable(scope: BrandScope): Promise<void> {
    const { evaluatorConfigured, monthlyCallsPerBrand } = this.deps.env.policy;
    if (!evaluatorConfigured) throw new ApiError(503, 'policy_evaluation_unavailable');
    const u = await this.#usage.current(scope, monthlyCallsPerBrand);
    if (u.used >= u.limit)
      throw new ApiError(
        429,
        'policy_quota_exhausted',
        `This brand has used its ${u.limit.toLocaleString('en-US')} policy checks for this month. Checks resume on ${resetDay(u.resetsAt)}.`,
      );
  }

  #producer(): NonNullable<AppDeps['producer']> {
    if (!this.producer) throw new ApiError(404, 'platform_not_configured');
    return this.producer;
  }

  async list(org: OrgContext, brandId: unknown): Promise<PolicyListDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { evaluatorConfigured, monthlyCallsPerBrand } = this.deps.env.policy;
    const [policies, usage] = await Promise.all([
      this.#store.list(scope),
      this.#usage.current(scope, monthlyCallsPerBrand),
    ]);
    return {
      policies: policies.map(toPolicyDto),
      limits: { maxPolicies: MAX_POLICIES_PER_BRAND, maxEnabled: MAX_ENABLED_POLICIES_PER_BRAND },
      usage: { used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt.toISOString() },
      evaluatorConfigured,
    };
  }

  async get(org: OrgContext, brandId: unknown, policyId: string): Promise<PolicyDetailDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const policy = await this.#store.get(scope, policyId);
    if (!policy) throw notFound();
    const revisions = await this.#store.revisions(scope, policyId);
    const names = await userNames(this.deps.pool, scope.organizationId, [
      ...new Set(revisions.flatMap((r) => (r.createdByUserId ? [r.createdByUserId] : []))),
    ]);
    return { ...toPolicyDto(policy), revisions: revisions.map((r) => toRevisionDto(r, names)) };
  }

  async create(org: OrgContext, brandId: unknown, body: unknown): Promise<PolicyDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const input = parsePolicy(policyInputSchema, body);
    try {
      const created = await this.#write(org, 'rule.write', async (c) => {
        const p = await this.#store.create(c, scope, input, org.actorUserId);
        await this.#audit(c, org, scope, {
          action: 'policy.created',
          subjectType: 'custom_policy',
          subjectId: p.id,
          details: { revision: p.revision, action: p.action, vague: p.vague },
        });
        return p;
      });
      return toPolicyDto(created);
    } catch (e) {
      throw this.#mapStoreError(e);
    }
  }

  async update(org: OrgContext, brandId: unknown, policyId: string, body: unknown) {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const patch = parsePolicy(policyPatchSchema, body);
    try {
      const updated = await this.#write(org, 'rule.write', async (c) => {
        const before = await this.#store.get(scope, policyId, c);
        const r =
          before &&
          (await this.#store.update(c, scope, policyId, definedOnly(patch), org.actorUserId));
        if (!before || !r) throw notFound();
        const { policy, revised, enabledChanged } = r;
        const subject = { subjectType: 'custom_policy', subjectId: policyId } as const;
        if (revised)
          await this.#audit(c, org, scope, {
            ...subject,
            action: 'policy.revised',
            details: {
              revision: policy.revision,
              action: policy.action,
              vague: policy.vague,
            },
          });
        if (patch.name !== undefined && patch.name !== before.name)
          await this.#audit(c, org, scope, { ...subject, action: 'policy.renamed' });
        if (enabledChanged)
          await this.#audit(c, org, scope, {
            ...subject,
            action: policy.enabled ? 'policy.enabled' : 'policy.disabled',
            details: { revision: policy.revision },
          });
        return policy;
      });
      return toPolicyDto(updated);
    } catch (e) {
      throw this.#mapStoreError(e);
    }
  }

  async archive(org: OrgContext, brandId: unknown, policyId: string): Promise<void> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#write(org, 'rule.write', async (c) => {
      if (!(await this.#store.archive(c, scope, policyId))) throw notFound();
      await this.#audit(c, org, scope, {
        action: 'policy.archived',
        subjectType: 'custom_policy',
        subjectId: policyId,
      });
    });
  }

  #mapStoreError(e: unknown): unknown {
    if (e instanceof PolicyLimitError)
      return new ApiError(
        409,
        'policy_limit_reached',
        e.limit === 'policies'
          ? `A brand can have at most ${e.max} policies.`
          : `At most ${e.max} policies can be enabled at once.`,
        { max: e.max },
      );
    if (e instanceof PolicyNameTakenError) return new ApiError(409, 'policy_name_taken');
    return e;
  }

  /**
   * Starts a dry run of a draft text on recent undecided comments. If a job cannot
   * be enqueued the preview is withdrawn, so it cannot block the next one.
   */
  async startPreview(org: OrgContext, brandId: unknown, body: unknown): Promise<{ id: string }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const input = parsePolicy(previewRequestSchema, body);
    if (input.policyId !== undefined && !(await this.#store.get(scope, input.policyId)))
      throw notFound();
    await this.#ensureAvailable(scope);
    const producer = this.#producer();
    let created;
    try {
      created = await this.#write(org, 'rule.write', async (c) => {
        const p = await this.#previews.create(c, scope, {
          policyId: input.policyId ?? null,
          text: input.text,
          action: input.action,
          days: input.days,
          userId: org.actorUserId,
        });
        await this.#audit(c, org, scope, {
          action: 'policy.preview_requested',
          subjectType: 'policy_preview',
          subjectId: p.id,
          details: { days: input.days, total: p.total, capped: p.capped },
        });
        return p;
      });
    } catch (e) {
      if (e instanceof PreviewInProgressError)
        throw new ApiError(409, 'policy_preview_in_progress');
      throw e;
    }
    if (created.connections.length === 0) {
      await this.#previews.completeIfDone(scope, created.id);
      return { id: created.id };
    }
    const results = await Promise.allSettled(
      created.connections.map((x) =>
        producer.enqueue({
          scope: { ...scope, connectionId: x.connectionId },
          platform: x.platform as Platform,
          type: POLICY_PREVIEW_JOB.type,
          payload: { previewId: created.id, chunk: 0 },
        }),
      ),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') {
      this.deps.log.error('policy preview enqueue failed', {
        previewId: created.id,
        ...errorFields(failed.reason),
      });
      await this.#withdraw(() => this.#previews.withdraw(scope, created.id), created.id);
      throw new ApiError(503, 'temporarily_unavailable');
    }
    return { id: created.id };
  }

  async preview(org: OrgContext, brandId: unknown, previewId: string): Promise<PreviewView> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const view = await this.#previews.view(scope, previewId);
    if (!view) throw notFound();
    return view;
  }

  /**
   * Records an explicit application of one enabled policy to recent comments and
   * fans out one job per active connection. Enabling never does this by itself.
   */
  async startRun(
    org: OrgContext,
    brandId: unknown,
    policyId: string,
    body: unknown,
  ): Promise<{ id: string | null; connections: number }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const { days } = parsePolicy(runRequestSchema, body);
    const policy = await this.#store.get(scope, policyId);
    if (!policy) throw notFound();
    await this.#ensureAvailable(scope);
    if (!policy.enabled) throw new ApiError(409, 'policy_not_enabled');
    const producer = this.#producer();
    const connections = await this.#store.activeConnections(scope);
    // Nothing to apply it to: no run is recorded, so the interval is not consumed.
    if (connections.length === 0) return { id: null, connections: 0 };
    const runId = await this.#write(org, 'rule.write', async (c) => {
      const run = await this.#store.insertRun(c, scope, {
        policyId,
        revisionId: policy.revisionId,
        days,
        userId: org.actorUserId,
      });
      if (run === 'too_soon') throw new ApiError(409, 'policy_run_too_soon');
      await this.#audit(c, org, scope, {
        action: 'policy.run_requested',
        subjectType: 'policy_run',
        subjectId: run.id,
        details: { days, revision: policy.revision },
      });
      return run.id;
    });
    const results = await Promise.allSettled(
      connections.map((x) =>
        producer.enqueue({
          scope: { ...scope, connectionId: x.connectionId },
          platform: x.platform as Platform,
          type: POLICY_RUN_JOB.type,
          payload: { runId },
        }),
      ),
    );
    const enqueued = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected')
      this.deps.log.error('policy run enqueue failed', {
        runId,
        enqueued,
        failed: results.length - enqueued,
        ...errorFields(failed.reason),
      });
    if (enqueued === 0) {
      await this.#withdraw(() => this.#store.withdrawRun(scope, runId), runId);
      throw new ApiError(503, 'temporarily_unavailable');
    }
    return { id: runId, connections: enqueued };
  }

  /** If even the withdrawal fails the row stays; a run then blocks retries until the interval passes. */
  async #withdraw(remove: () => Promise<void>, id: string) {
    try {
      await remove();
    } catch (e) {
      this.deps.log.error('policy withdraw failed', { id, ...errorFields(e) });
    }
  }
}
