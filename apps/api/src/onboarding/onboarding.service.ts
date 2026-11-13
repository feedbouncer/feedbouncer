import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { can } from '@feedbouncer/authz';
import { CATEGORIES, PgThresholdStore, type Category } from '@feedbouncer/classifier';
import { reviewModeState, systemClock } from '@feedbouncer/connectors';
import { withTransaction } from '@feedbouncer/db';
import { computeAccountBreakdown, computePeriodSummary } from '@feedbouncer/reports';
import type pg from 'pg';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { connectablePlatforms } from '../connections/connectable-platforms.js';
import { ClassifierService } from '../classifier/classifier.service.js';
import { ConnectionsService, viewStatus } from '../connections/connections.service.js';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { ReviewModeService } from '../review-mode/review-mode.service.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import { orgCan, type OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';
import {
  toOnboardingConnection,
  type DefaultAction,
  type DefaultCategoryDto,
  type OnboardingDefaultsDto,
  type OnboardingReportDto,
  type OnboardingStateDto,
} from './dto.js';
import {
  STEPS,
  isComplete,
  isReachable,
  markDone,
  resetAll,
  resumeStep,
  type Step,
  type StepStatuses,
} from './steps.js';

interface StateRow {
  brand_id: string | null;
  run: number;
  connect_status: 'pending' | 'done';
  defaults_status: 'pending' | 'done';
  review_mode_status: 'pending' | 'done';
  report_status: 'pending' | 'done';
  review_mode_choice: 'review' | 'automatic' | null;
  started_by_user_id: string | null;
  dismissed_at: Date | null;
  completed_at: Date | null;
}

/** The mutable part of the row: what a step handler may change. */
interface WizardState {
  brandId: string | null;
  run: number;
  steps: StepStatuses;
  reviewModeChoice: 'review' | 'automatic' | null;
  dismissed: boolean;
}

interface Audit {
  action: AuditAction;
  details?: Record<string, string | number | boolean | null>;
}

/** What a mutation decided: the next state, and an audit event only when something changed. */
interface Mutation {
  next: WizardState;
  audit?: Audit;
}

const COLUMNS = `brand_id, run, connect_status, defaults_status, review_mode_status, report_status,
  review_mode_choice, started_by_user_id, dismissed_at, completed_at`;

const stepsOf = (r: StateRow): StepStatuses => ({
  connect: r.connect_status,
  defaults: r.defaults_status,
  review_mode: r.review_mode_status,
  report: r.report_status,
});

const stateOf = (r: StateRow): WizardState => ({
  brandId: r.brand_id,
  run: r.run,
  steps: stepsOf(r),
  reviewModeChoice: r.review_mode_choice,
  dismissed: r.dismissed_at !== null,
});

/** sha256 hex of the rows sorted by category, joined as `category:action:threshold`. */
export function defaultsFingerprint(
  rows: readonly { category: string; action: string; threshold: number }[],
): string {
  const text = [...rows]
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
    .map((r) => `${r.category}:${r.action}:${r.threshold}`)
    .join(',');
  return createHash('sha256').update(text).digest('hex');
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(ClassifierService) private readonly classifier: ClassifierService,
    @Inject(ReviewModeService) private readonly reviewMode: ReviewModeService,
  ) {}

  /** Never writes. */
  async get(org: OrgContext): Promise<OnboardingStateDto> {
    const row = await this.#row(this.deps.pool, org.organizationId);
    return this.#dto(org, this.deps.pool, row);
  }

  async start(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (_c, cur, created) => ({
      next: cur,
      ...(created && { audit: { action: 'onboarding.started' as const } }),
    }));
  }

  async setBrand(org: OrgContext, brandId: string): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (c, cur) => {
      await requireBrand(c, org, brandId);
      if (cur.brandId === brandId) return { next: cur };
      return {
        next: { ...cur, brandId },
        audit: { action: 'onboarding.brand_selected', details: { brandId } },
      };
    });
  }

  async completeConnect(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (c, cur) => {
      if (!cur.brandId) throw new ApiError(409, 'onboarding_no_brand');
      const { rows } = await c.query<{ status: string; status_reason: string | null }>(
        'SELECT status, status_reason FROM connection WHERE organization_id = $1 AND brand_id = $2',
        [org.organizationId, cur.brandId],
      );
      if (!rows.some((x) => viewStatus(x.status, x.status_reason) === 'connected'))
        throw new ApiError(409, 'onboarding_no_working_connection');
      const { next, changed } = markDone(cur.steps, 'connect');
      if (!changed) return { next: cur };
      return {
        next: { ...cur, steps: next },
        audit: {
          action: 'onboarding.step_completed',
          details: { step: 'connect', brandId: cur.brandId },
        },
      };
    });
  }

  /** Never writes. Needs a live brand; the step order is enforced on the write only. */
  async defaults(org: OrgContext): Promise<OnboardingDefaultsDto> {
    const row = await this.#row(this.deps.pool, org.organizationId);
    const brandId = await this.#targetBrand(
      this.deps.pool,
      org.organizationId,
      row?.brand_id ?? null,
    );
    if (!brandId) throw new ApiError(409, 'onboarding_no_brand');
    return this.#defaultsView(this.deps.pool, { organizationId: org.organizationId, brandId });
  }

  /**
   * Saves the moderation defaults. `choices` is exactly the categories whose current action is
   * not `remove` (those are left alone); only the ones that differ are written, each keeping its
   * current threshold. The fingerprint is checked under the row lock.
   */
  async saveDefaults(
    org: OrgContext,
    input: { choices: { category: Category; action: DefaultAction }[]; basedOn: string },
  ): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (c, cur) => {
      if (!isReachable(cur.steps, 'defaults')) throw new ApiError(409, 'onboarding_step_locked');
      if (!cur.brandId) throw new ApiError(409, 'onboarding_no_brand');
      const scope = { organizationId: org.organizationId, brandId: cur.brandId };
      // The organization lock taken by #mutate serializes classifier writers.
      const view = await this.#defaultsView(c, scope);
      if (view.basedOn !== input.basedOn)
        throw new ApiError(409, 'onboarding_defaults_stale', undefined, {
          categories: view.categories,
        });
      const current = new Map(view.categories.map((x) => [x.category, x]));
      const sent = new Set(input.choices.map((x) => x.category));
      const expected = CATEGORIES.filter((x) => current.get(x)?.action !== 'remove');
      if (
        sent.size !== input.choices.length ||
        expected.some((x) => !sent.has(x)) ||
        sent.size !== expected.length
      )
        throw new ApiError(400, 'invalid_request');
      const changes = input.choices.filter((x) => current.get(x.category)?.action !== x.action);
      if (changes.length > 0) {
        await this.classifier.updateWithin(
          c,
          org,
          scope,
          changes.map((x) => ({
            category: x.category,
            action: x.action,
            threshold: current.get(x.category)!.threshold,
          })),
        );
      }
      // A repeat of an identical save on a finished step has nothing to record.
      if (changes.length === 0 && cur.steps.defaults === 'done') return { next: cur };
      const { next } = markDone(cur.steps, 'defaults');
      return {
        next: { ...cur, steps: next },
        audit: {
          action: 'onboarding.defaults_saved',
          // Audit details are scalars only, so the categories are comma-joined.
          details: { changed: changes.map((x) => x.category).join(',') },
        },
      };
    });
  }

  /**
   * Step 3. `review` changes nothing; `automatic` ends every active review window of the target
   * brand, leaving queued suggestions for a human. Retry-safe: ended windows are left as they are and an
   * unchanged outcome writes no audit event.
   */
  async chooseReviewMode(
    org: OrgContext,
    choice: 'review' | 'automatic',
  ): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (c, cur) => {
      if (!isReachable(cur.steps, 'review_mode')) throw new ApiError(409, 'onboarding_step_locked');
      if (!cur.brandId) throw new ApiError(409, 'onboarding_no_brand');
      const rows = (
        await c.query<{
          id: string;
          review_mode: 'legacy' | 'on' | 'opted_out';
          review_mode_started_at: Date | null;
          review_mode_ends_at: Date | null;
          review_mode_ended_at: Date | null;
        }>(
          `SELECT id, review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at
             FROM connection WHERE organization_id = $1 AND brand_id = $2
            ORDER BY created_at, id FOR UPDATE`,
          [org.organizationId, cur.brandId],
        )
      ).rows;
      const now = new Date(systemClock.now());
      const states = rows.map((r) => ({
        id: r.id,
        state: reviewModeState(
          {
            mode: r.review_mode,
            startedAt: r.review_mode_started_at,
            endsAt: r.review_mode_ends_at,
            endedAt: r.review_mode_ended_at,
          },
          now,
        ),
      }));
      const active = states.filter((s) => s.state === 'active');
      const endedIds: string[] = [];
      const optedOutIds: string[] = [];
      if (choice === 'review') {
        if (active.length === 0 && states.some((s) => s.state !== 'off'))
          throw new ApiError(409, 'onboarding_review_unavailable');
      } else {
        // No connection.manage check: org.update and connection.manage are both owner/admin-only
        // and neither is grantable, so #mutate's org.update recheck already covers it.
        for (const s of active) {
          const scope = {
            organizationId: org.organizationId,
            brandId: cur.brandId,
            connectionId: s.id,
          };
          // A window that never started cannot be ended and would start on first activation,
          // so that connection is opted out of review mode instead.
          if (await this.reviewMode.endLeavingPendingWithin(c, org, scope)) endedIds.push(s.id);
          else {
            await this.reviewMode.optOutWithin(c, org, scope);
            optedOutIds.push(s.id);
          }
        }
      }
      const { next, changed } = markDone(cur.steps, 'review_mode');
      if (
        !changed &&
        cur.reviewModeChoice === choice &&
        endedIds.length === 0 &&
        optedOutIds.length === 0
      )
        return { next: cur };
      return {
        next: { ...cur, steps: next, reviewModeChoice: choice },
        audit: {
          action: 'onboarding.review_mode_chosen',
          // Audit details are scalars only, so the ids are comma-joined.
          details: {
            choice,
            endedConnectionIds: endedIds.join(','),
            optedOutConnectionIds: optedOutIds.join(','),
          },
        },
      };
    });
  }

  /**
   * Step 4 read: the last 30 days of the target brand, from one repeatable-read read-only
   * snapshot. Comment text is never selected (no notable threads).
   */
  async report(org: OrgContext): Promise<OnboardingReportDto> {
    const row = await this.#row(this.deps.pool, org.organizationId);
    const brandId = await this.#targetBrand(
      this.deps.pool,
      org.organizationId,
      row?.brand_id ?? null,
    );
    if (!brandId) throw new ApiError(409, 'onboarding_no_brand');
    const [connections, view] = await Promise.all([
      this.connections.list(org, brandId),
      this.#defaultsView(this.deps.pool, { organizationId: org.organizationId, brandId }),
    ]);
    const to = new Date(systemClock.now());
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const { summary, breakdown } = await withTransaction(
      this.deps.pool,
      async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        const q = { from, to, brandId };
        return {
          summary: await computePeriodSummary(c, org.organizationId, q),
          breakdown: await computeAccountBreakdown(c, org.organizationId, q),
        };
      },
      { isolation: 'repeatable read' },
    );
    const byId = new Map(connections.map((x) => [x.id, toOnboardingConnection(x)]));
    const accounts = breakdown.flatMap((b) => {
      const conn = byId.get(b.connectionId);
      return conn
        ? [
            {
              ...b,
              platform: conn.platform,
              displayName: conn.displayName,
              status: conn.status,
              backfill: conn.backfill,
            },
          ]
        : [];
    });
    const sync =
      accounts.length === 0
        ? 'no_connections'
        : accounts.some((a) => a.backfill?.status === 'pending' || a.backfill?.status === 'running')
          ? 'syncing'
          : 'ready';
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      reviewModeChoice: row?.review_mode_choice ?? null,
      defaults: view.categories
        .filter((x) => x.action !== 'remove')
        .map((x) => ({ category: x.category, action: x.action })),
      sync,
      totals: summary.totals,
      categories: summary.categories,
      accounts,
      empty: summary.totals.comments === 0,
    };
  }

  /** Finishing the last step sets completed_at (in #mutate). Never blocked by a running sync. */
  async completeReport(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (_c, cur) => {
      if (!isReachable(cur.steps, 'report')) throw new ApiError(409, 'onboarding_step_locked');
      const { next, changed } = markDone(cur.steps, 'report');
      if (!changed) return { next: cur };
      return {
        next: { ...cur, steps: next },
        audit: {
          action: 'onboarding.step_completed',
          details: { step: 'report', brandId: cur.brandId },
        },
      };
    });
  }

  async #defaultsView(
    db: Pick<pg.Pool, 'query'>,
    scope: { organizationId: string; brandId: string },
  ): Promise<OnboardingDefaultsDto> {
    const categories: DefaultCategoryDto[] = (await new PgThresholdStore(db).list(scope)).map(
      (x) => ({
        category: x.category,
        action: x.action as DefaultCategoryDto['action'],
        threshold: x.threshold,
        source: x.source,
      }),
    );
    return {
      aiEnabled: this.deps.env.classifier.enabled,
      categories,
      basedOn: defaultsFingerprint(categories),
    };
  }

  async dismiss(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (_c, cur) =>
      cur.dismissed
        ? { next: cur }
        : { next: { ...cur, dismissed: true }, audit: { action: 'onboarding.dismissed' } },
    );
  }

  /** Resets only the wizard's progress; classifier settings and review modes are left alone. */
  async rerun(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (_c, cur) => ({
      next: {
        ...cur,
        run: cur.run + 1,
        steps: resetAll(),
        reviewModeChoice: null,
        dismissed: false,
      },
      audit: { action: 'onboarding.rerun', details: { run: cur.run + 1 } },
    }));
  }

  /**
   * The one write path, reused by every step: locks the organization and the actor's role,
   * makes sure the row exists, locks it, lets `fn` decide the next state, then persists it
   * (plus the effective brand) and its audit event in the same transaction.
   */
  async #mutate(
    org: OrgContext,
    fn: (c: pg.PoolClient, cur: WizardState, created: boolean) => Promise<Mutation>,
  ): Promise<OnboardingStateDto> {
    const row = await withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, org), 'org.update', org.grants))
        throw new ApiError(403, 'forbidden');
      const brandId = await this.#targetBrand(c, org.organizationId, null);
      const ins = await c.query(
        `INSERT INTO onboarding_state (organization_id, brand_id, started_by_user_id, last_actor_user_id)
         VALUES ($1, $2, $3, $3) ON CONFLICT (organization_id) DO NOTHING`,
        [org.organizationId, brandId, org.actorUserId],
      );
      const created = ins.rowCount === 1;
      const cur = (await this.#row(c, org.organizationId, true))!;
      const state = stateOf(cur);
      state.brandId = await this.#targetBrand(c, org.organizationId, cur.brand_id);
      const { next, audit } = await fn(c, state, created);
      const done = isComplete(next.steps);
      const upd = await c.query<StateRow>(
        `UPDATE onboarding_state SET brand_id = $2, run = $3, connect_status = $4,
                defaults_status = $5, review_mode_status = $6, report_status = $7,
                review_mode_choice = $8, last_actor_user_id = $9,
                dismissed_at = CASE WHEN $10::boolean THEN COALESCE(dismissed_at, $11::timestamptz) END,
                completed_at = CASE WHEN $12::boolean THEN COALESCE(completed_at, $11::timestamptz) END
          WHERE organization_id = $1 RETURNING ${COLUMNS}`,
        [
          org.organizationId,
          next.brandId,
          next.run,
          next.steps.connect,
          next.steps.defaults,
          next.steps.review_mode,
          next.steps.report,
          next.reviewModeChoice,
          org.actorUserId,
          next.dismissed,
          new Date(systemClock.now()),
          done,
        ],
      );
      if (audit) {
        await recordAudit(c, {
          organizationId: org.organizationId,
          brandId: next.brandId,
          actorUserId: org.actorUserId,
          action: audit.action,
          subjectType: 'organization',
          subjectId: org.organizationId,
          ...(audit.details && { details: audit.details }),
        });
      }
      return upd.rows[0]!;
    });
    return this.#dto(org, this.deps.pool, row);
  }

  async #row(
    db: Pick<pg.Pool, 'query'>,
    organizationId: string,
    lock = false,
  ): Promise<StateRow | null> {
    const r = await db.query<StateRow>(
      `SELECT ${COLUMNS} FROM onboarding_state WHERE organization_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [organizationId],
    );
    return r.rows[0] ?? null;
  }

  /** The stored brand while it is live, else the oldest live brand, else null. */
  async #targetBrand(
    db: Pick<pg.Pool, 'query'>,
    organizationId: string,
    stored: string | null,
  ): Promise<string | null> {
    const r = await db.query<{ id: string }>(
      `SELECT id FROM brand WHERE organization_id = $1 AND archived_at IS NULL
        ORDER BY (id = $2::uuid) DESC, created_at, id LIMIT 1`,
      [organizationId, stored],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * True when the org already has something set up: any connection other than one still waiting
   * for its OAuth grant, any classifier threshold, or any rule that is not archived.
   */
  async #preconfigured(db: Pick<pg.Pool, 'query'>, organizationId: string): Promise<boolean> {
    const r = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM connection WHERE organization_id = $1
            AND NOT (status = 'reconnect_required' AND status_reason IS NOT DISTINCT FROM 'oauth_pending')
       ) OR EXISTS (
         SELECT 1 FROM classifier_threshold WHERE organization_id = $1
       ) OR EXISTS (
         SELECT 1 FROM rule WHERE organization_id = $1 AND archived_at IS NULL
       ) AS configured`,
      [organizationId],
    );
    return r.rows[0]?.configured === true;
  }

  async #dto(
    org: OrgContext,
    db: Pick<pg.Pool, 'query'>,
    row: StateRow | null,
  ): Promise<OnboardingStateDto> {
    const orgId = org.organizationId;
    const brands = (
      await db.query<{ id: string; name: string }>(
        `SELECT id, name FROM brand WHERE organization_id = $1 AND archived_at IS NULL
          ORDER BY created_at, id`,
        [orgId],
      )
    ).rows;
    const targetId = await this.#targetBrand(db, orgId, row?.brand_id ?? null);
    const brand = brands.find((b) => b.id === targetId) ?? null;
    const steps: StepStatuses = row ? stepsOf(row) : resetAll();
    const preconfigured = row === null && (await this.#preconfigured(db, orgId));
    const dismissed = row?.dismissed_at != null;
    const complete = isComplete(steps);
    const connections = brand ? await this.connections.list(org, brand.id) : [];
    return {
      started: row !== null,
      autoStart: row === null && !preconfigured && orgCan(org, 'org.update'),
      preconfigured,
      dismissed,
      complete,
      run: row?.run ?? 1,
      steps,
      resumeStep: resumeStep(steps),
      reachable: Object.fromEntries(STEPS.map((s: Step) => [s, isReachable(steps, s)])) as Record<
        Step,
        boolean
      >,
      brand,
      brands,
      configuredPlatforms: connectablePlatforms(this.deps),
      connections: connections.map(toOnboardingConnection),
      reviewModeChoice: row?.review_mode_choice ?? null,
    };
  }
}
