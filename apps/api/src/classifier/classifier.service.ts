import { Inject, Injectable } from '@nestjs/common';
import { can } from '@feedbouncer/authz';
import {
  CLASSIFIER_RERUN_JOB,
  PgClassificationStore,
  PgThresholdStore,
  applyItems,
  previewChange,
  type ClassificationView,
  type ThresholdItem,
} from '@feedbouncer/classifier';
import { withTransaction } from '@feedbouncer/db';
import type { Platform } from '@feedbouncer/connectors';
import { errorFields } from '@feedbouncer/service-runtime';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireBrand, type BrandScope } from '../tenancy/brand-scope.js';
import { lockedActor } from '../tenancy/org-lock.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS, JOB_PRODUCER } from '../tokens.js';
import {
  activeConnections,
  deleteRun,
  hasRecentRun,
  insertRun,
  runCounts,
  userNames,
  type RerunReport,
} from './classification.queries.js';

export const RERUN_MIN_INTERVAL_MINUTES = 15;
const PREVIEW_MAX_ROWS = 20_000;
const DAY_MS = 86_400_000;

export interface ThresholdViewDto {
  category: string;
  threshold: number;
  action: string;
  source: 'default' | 'brand';
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
}

@Injectable()
export class ClassifierService {
  readonly #thresholds: PgThresholdStore;
  readonly #classifications: PgClassificationStore;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(JOB_PRODUCER) private readonly producer: AppDeps['producer'],
  ) {
    this.#thresholds = new PgThresholdStore(deps.pool);
    this.#classifications = new PgClassificationStore(deps.pool);
  }

  async scope(org: OrgContext, brandId: unknown): Promise<BrandScope> {
    return requireBrand(this.deps.pool, org, brandId);
  }

  async #views(scope: BrandScope): Promise<ThresholdViewDto[]> {
    const list = await this.#thresholds.list(scope);
    const ids = [...new Set(list.flatMap((t) => (t.updatedByUserId ? [t.updatedByUserId] : [])))];
    const names = await userNames(this.deps.pool, scope.organizationId, ids);
    return list.map((t) => ({
      category: t.category,
      threshold: t.threshold,
      action: t.action,
      source: t.source,
      updatedAt: t.updatedAt?.toISOString() ?? null,
      updatedBy:
        t.updatedByUserId !== null
          ? { id: t.updatedByUserId, name: names.get(t.updatedByUserId) ?? null }
          : null,
    }));
  }

  async settings(scope: BrandScope) {
    const { id, model, enabled } = this.deps.env.classifier;
    return { provider: { id, model, enabled }, categories: await this.#views(scope) };
  }

  async update(org: OrgContext, scope: BrandScope, items: readonly ThresholdItem[]) {
    await withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, org), 'rule.write')) throw new ApiError(403, 'forbidden');
      const changes = await this.#thresholds.apply(c, scope, items, org.actorUserId);
      for (const ch of changes) {
        await recordAudit(c, {
          organizationId: scope.organizationId,
          brandId: scope.brandId,
          actorUserId: org.actorUserId,
          action: ch.after === null ? 'classifier_threshold.reset' : 'classifier_threshold.updated',
          subjectType: 'classifier_threshold',
          subjectId: null,
          details: {
            category: ch.category,
            threshold_before: ch.before?.threshold ?? null,
            action_before: ch.before?.action ?? null,
            threshold_after: ch.after?.threshold ?? null,
            action_after: ch.after?.action ?? null,
          },
        });
      }
    });
    return { categories: await this.#views(scope) };
  }

  async preview(
    scope: BrandScope,
    items: readonly ThresholdItem[],
    days: number,
    now = new Date(),
  ) {
    const current = await this.#thresholds.policy(scope);
    const proposed = applyItems(current, items);
    const since = new Date(now.getTime() - days * DAY_MS);
    const { rows, capped } = await this.#classifications.previewRows(
      scope,
      since,
      PREVIEW_MAX_ROWS,
    );
    return {
      window: { from: since.toISOString(), to: now.toISOString() },
      ...previewChange(rows, current, proposed),
      capped,
    };
  }

  /**
   * Records the run under the brand lock (one per 15 minutes) and fans out one
   * job per active connection. If no job could be enqueued the run is withdrawn so
   * the caller can retry at once; if some were, the run stays and the counts say
   * how many connections were skipped.
   */
  async rerun(org: OrgContext, scope: BrandScope, days: number, now = new Date()) {
    const producer = this.producer;
    const registry = this.deps.connectors?.registry;
    if (!producer || !registry) throw new ApiError(404, 'platform_not_configured');
    const since = new Date(now.getTime() - days * DAY_MS);
    const runId = await withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, org), 'rule.write')) throw new ApiError(403, 'forbidden');
      const lock = await c.query(
        'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE',
        [scope.organizationId, scope.brandId],
      );
      if (lock.rowCount === 0) throw notFound();
      if (await hasRecentRun(c, scope, RERUN_MIN_INTERVAL_MINUTES))
        throw new ApiError(409, 'classifier_rerun_too_soon');
      const id = await insertRun(c, scope, org.actorUserId, days, since);
      await recordAudit(c, {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        actorUserId: org.actorUserId,
        action: 'classifier.rerun_requested',
        subjectType: 'classifier_run',
        subjectId: id,
        details: { days },
      });
      return id;
    });
    const connections = (await activeConnections(this.deps.pool, scope)).filter(
      (x) => registry.get(x.platform as Platform) !== undefined,
    );
    const results = await Promise.allSettled(
      connections.map((x) =>
        producer.enqueue({
          scope: { ...scope, connectionId: x.id },
          platform: x.platform as Platform,
          type: CLASSIFIER_RERUN_JOB.type,
          payload: { runId, since: since.getTime() },
        }),
      ),
    );
    const enqueued = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - enqueued;
    if (failed > 0) {
      const first = results.find((r) => r.status === 'rejected');
      this.deps.log.error('classifier rerun enqueue failed', {
        runId,
        enqueued,
        failed,
        ...errorFields(first?.status === 'rejected' ? first.reason : undefined),
      });
    }
    if (enqueued === 0 && failed > 0) {
      // Nothing is running, so the run is withdrawn and a retry is safe. If even that
      // fails the row stays and blocks retries until the interval has passed.
      try {
        await deleteRun(this.deps.pool, scope, runId);
      } catch (e) {
        this.deps.log.error('classifier rerun withdraw failed', { runId, ...errorFields(e) });
      }
      throw new ApiError(503, 'temporarily_unavailable');
    }
    return { runId, enqueued, failed };
  }

  run(scope: BrandScope, runId: string): Promise<RerunReport> {
    return runCounts(this.deps.pool, scope, runId);
  }

  latestForComment(scope: BrandScope, commentId: string): Promise<ClassificationView | null> {
    return this.#classifications.latestForComment(scope, commentId);
  }
}
