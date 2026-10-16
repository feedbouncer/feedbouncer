import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import {
  checkStepsForBrand,
  loadBrandConnections,
  type ActionStep,
  type StepIssue,
  type StepWarning,
} from '@feedbouncer/actions';
import { can, type Capability } from '@feedbouncer/authz';
import type { Platform } from '@feedbouncer/connectors';
import { withTransaction } from '@feedbouncer/db';
import {
  DomainLimitError,
  InvalidRuleActionError,
  InvalidRuleConditionsError,
  PgRuleStore,
  RuleLimitError,
  analyzeRules,
  checkActionForConditions,
  normalizeDomainEntry,
  ruleInputSchema,
  rulePatchSchema,
  type BrandDomain,
  type StoredRule,
} from '@feedbouncer/rules';
import { recordAudit, type AuditInput } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound, type ErrorIssue } from '../http/errors.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import { lockedActor } from '../tenancy/org-lock.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS } from '../tokens.js';
import { listActivity, type ActivityItem, type ActivityQuery } from './decisions.queries.js';
import { toDomainDto, type DomainDto, type RuleDto, type RuleWriteDto } from './rules.dto.js';

const MAX_ISSUE_CHARS = 300;

function invalidRule(issues: ErrorIssue[]): ApiError {
  return new ApiError(400, 'invalid_rule', undefined, { issues });
}

/** A step-level problem (path "actions.<n>..."), as opposed to a malformed body or conditions. */
const isStepIssue = (path: PropertyKey[]): boolean => path[0] === 'actions' && path.length > 1;

function parseRule<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message.slice(0, MAX_ISSUE_CHARS),
  }));
  if (r.error.issues.every((i) => isStepIssue(i.path)))
    throw new ApiError(422, 'invalid_actions', undefined, { issues });
  throw invalidRule(issues);
}

function stepErrors(errors: readonly StepIssue[]): ApiError {
  return new ApiError(422, 'invalid_actions', undefined, {
    issues: errors.map((e) => ({
      path: `actions.${e.index}`,
      message: e.code,
      ...(e.platform && { platform: e.platform }),
      ...(e.max !== undefined && { max: e.max }),
    })),
  });
}

/** Platform an author rule is limited to; other rules run on every platform of the brand. */
const rulePlatform = (conditions: unknown): Platform | undefined => {
  const c = conditions as { type?: unknown; platform?: unknown } | null;
  return c?.type === 'author' ? (c.platform as Platform) : undefined;
};

@Injectable()
export class RulesService {
  readonly #store: PgRuleStore;

  constructor(@Inject(DEPS) private readonly deps: AppDeps) {
    this.#store = new PgRuleStore(deps.pool);
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

  /** The brand's rules in evaluation order, with static-analysis warnings. */
  async #views(scope: BrandScope): Promise<RuleDto[]> {
    const rules = await this.#store.list(scope);
    const warnings = analyzeRules(rules);
    const names = new Map(rules.map((r) => [r.id, r.name]));
    return rules.map((r, i) => {
      const w = warnings.get(r.id);
      const by = w?.shadowedBy ?? null;
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        conditions: r.conditions,
        action: r.action,
        actions: r.actions,
        mode: r.mode,
        enabled: r.enabled,
        position: i + 1,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        warnings: {
          shadowedBy: by === null ? null : { id: by, name: names.get(by) ?? '' },
          neverMatches: w?.neverMatches ?? false,
          invalid: w?.invalid ?? false,
        },
      };
    });
  }

  async #view(scope: BrandScope, ruleId: string): Promise<RuleDto> {
    const v = (await this.#views(scope)).find((r) => r.id === ruleId);
    if (!v) throw notFound();
    return v;
  }

  /**
   * The steps checked against the brand's connections: problems no connection can carry out
   * are errors, partial problems are warnings.
   */
  async #checkSteps(
    db: pg.Pool | pg.PoolClient,
    scope: BrandScope,
    conditions: unknown,
    steps: readonly ActionStep[],
  ): Promise<ReturnType<typeof checkStepsForBrand>> {
    const registry = this.deps.connectors?.registry;
    const capabilities = (p: Platform) => registry?.get(p)?.capabilities;
    const conns = await loadBrandConnections(db, scope, capabilities);
    return checkStepsForBrand(steps, conns, rulePlatform(conditions), capabilities);
  }

  #ruleDetails(r: StoredRule, changed?: string[]) {
    return {
      kind: r.kind,
      action: r.action,
      steps: r.actions.map((a) => a.type).join(','),
      mode: r.mode,
      enabled: r.enabled,
      ...(changed && { changed: changed.join(',') }),
    };
  }

  async list(org: OrgContext, brandId: unknown): Promise<RuleDto[]> {
    return this.#views(await requireBrand(this.deps.pool, org, brandId));
  }

  async get(org: OrgContext, brandId: unknown, ruleId: string): Promise<RuleDto> {
    return this.#view(await requireBrand(this.deps.pool, org, brandId), ruleId);
  }

  async create(org: OrgContext, brandId: unknown, body: unknown): Promise<RuleWriteDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const input = parseRule(ruleInputSchema, body);
    const problem = checkActionForConditions(input.conditions, input.actions);
    if (problem !== null) throw invalidRule([{ path: 'actions', message: problem }]);
    try {
      const { rule, warnings } = await this.#write(org, 'rule.write', async (c) => {
        const checked = await this.#checkSteps(c, scope, input.conditions, input.actions);
        if (checked.errors.length > 0) throw stepErrors(checked.errors);
        const created = await this.#store.create(c, scope, input);
        await this.#audit(c, org, scope, {
          action: 'rule.created',
          subjectType: 'rule',
          subjectId: created.id,
          details: this.#ruleDetails(created),
        });
        return { rule: created, warnings: checked.warnings };
      });
      return { ...(await this.#view(scope, rule.id)), actionWarnings: warnings };
    } catch (e) {
      if (e instanceof RuleLimitError) throw new ApiError(409, 'rule_limit_reached');
      throw e;
    }
  }

  async update(
    org: OrgContext,
    brandId: unknown,
    ruleId: string,
    body: unknown,
  ): Promise<RuleWriteDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const patch = parseRule(rulePatchSchema, body);
    let warnings: StepWarning[];
    try {
      warnings = await this.#write(org, 'rule.write', async (c) => {
        const before = await this.#store.get(scope, ruleId, c);
        const updated = await this.#store.update(c, scope, ruleId, patch);
        if (!before || !updated) throw notFound();
        // Only a change to the steps or the platform can be refused; later changes to the
        // brand's connections just show up as warnings.
        const changesSteps =
          patch.actions !== undefined ||
          rulePlatform(updated.conditions) !== rulePlatform(before.conditions);
        const checked = await this.#checkSteps(c, scope, updated.conditions, updated.actions);
        if (changesSteps && checked.errors.length > 0) throw stepErrors(checked.errors);
        await this.#audit(c, org, scope, {
          action: 'rule.updated',
          subjectType: 'rule',
          subjectId: updated.id,
          details: this.#ruleDetails(updated, Object.keys(patch)),
        });
        return checked.warnings;
      });
    } catch (e) {
      // The store re-checks the merged rule: the stored conditions or the new action do not fit.
      if (e instanceof InvalidRuleActionError)
        throw invalidRule([
          { path: 'actions', message: 'These actions are not allowed for this kind of rule.' },
        ]);
      if (e instanceof InvalidRuleConditionsError)
        throw invalidRule([{ path: 'conditions', message: 'The rule conditions are not valid.' }]);
      throw e;
    }
    return { ...(await this.#view(scope, ruleId)), actionWarnings: warnings };
  }

  async archive(org: OrgContext, brandId: unknown, ruleId: string): Promise<void> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#write(org, 'rule.write', async (c) => {
      const before = await this.#store.get(scope, ruleId, c);
      if (!before || !(await this.#store.archive(c, scope, ruleId))) throw notFound();
      await this.#audit(c, org, scope, {
        action: 'rule.archived',
        subjectType: 'rule',
        subjectId: ruleId,
        details: this.#ruleDetails(before),
      });
    });
  }

  async reorder(org: OrgContext, brandId: unknown, ruleIds: string[]): Promise<RuleDto[]> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#write(org, 'rule.write', async (c) => {
      if ((await this.#store.reorder(c, scope, ruleIds)) === 'mismatch')
        throw new ApiError(409, 'rule_order_mismatch');
      await this.#audit(c, org, scope, {
        action: 'rule.reordered',
        subjectType: 'rule',
        subjectId: null,
        details: { count: ruleIds.length },
      });
    });
    return this.#views(scope);
  }

  async listDomains(org: OrgContext, brandId: unknown): Promise<DomainDto[]> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    return (await this.#store.listDomains(scope)).map(toDomainDto);
  }

  async addDomain(org: OrgContext, brandId: unknown, input: string): Promise<DomainDto> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const domain = normalizeDomainEntry(input);
    if (domain === null) throw new ApiError(400, 'invalid_domain');
    let added: BrandDomain | 'exists';
    try {
      added = await this.#write(org, 'brand.write', async (c) => {
        const r = await this.#store.addDomain(c, scope, domain);
        if (r !== 'exists')
          await this.#audit(c, org, scope, {
            action: 'brand_domain.added',
            subjectType: 'brand_domain',
            subjectId: r.id,
          });
        return r;
      });
    } catch (e) {
      if (e instanceof DomainLimitError) throw new ApiError(409, 'domain_limit_reached');
      throw e;
    }
    if (added === 'exists') throw new ApiError(409, 'domain_exists');
    return toDomainDto(added);
  }

  async removeDomain(org: OrgContext, brandId: unknown, domainId: string): Promise<void> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    await this.#write(org, 'brand.write', async (c) => {
      if (!(await this.#store.removeDomain(c, scope, domainId))) throw notFound();
      await this.#audit(c, org, scope, {
        action: 'brand_domain.removed',
        subjectType: 'brand_domain',
        subjectId: domainId,
      });
    });
  }

  async activity(
    org: OrgContext,
    brandId: unknown,
    q: ActivityQuery,
  ): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    const scope = await requireBrand(this.deps.pool, org, brandId);
    const rows = await listActivity(this.deps.pool, scope, q);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => r.item),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.sequence : null,
    };
  }
}
