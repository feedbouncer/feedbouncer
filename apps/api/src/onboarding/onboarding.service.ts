import { Inject, Injectable } from '@nestjs/common';
import { can } from '@feedbouncer/authz';
import { systemClock } from '@feedbouncer/connectors';
import { withTransaction } from '@feedbouncer/db';
import type pg from 'pg';
import { recordAudit, type AuditAction } from '../audit/audit.js';
import { connectablePlatforms } from '../connections/connectable-platforms.js';
import { ConnectionsService } from '../connections/connections.service.js';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { requireBrand } from '../tenancy/brand-scope.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';
import { toOnboardingConnection, type OnboardingStateDto } from './dto.js';
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
export interface WizardState {
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
export interface Mutation {
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

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
  ) {}

  /** Never writes. */
  async get(org: OrgContext): Promise<OnboardingStateDto> {
    const row = await this.#row(this.deps.pool, org.organizationId);
    return this.#dto(org, this.deps.pool, row);
  }

  async start(org: OrgContext): Promise<OnboardingStateDto> {
    return this.#mutate(org, async (c, cur, created) => ({
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
    return this.#mutate(org, async (_c, cur) => {
      if (!cur.brandId) throw new ApiError(409, 'onboarding_no_brand');
      const list = await this.connections.list(org, cur.brandId);
      if (!list.some((x) => x.status === 'connected'))
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
      const role = await lockedActor(c, org);
      if (!can(role, 'connection.manage', org.grants)) throw new ApiError(403, 'forbidden');
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

  async #preconfigured(db: Pick<pg.Pool, 'query'>, organizationId: string): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM classifier_threshold WHERE organization_id = $1
       UNION ALL
       SELECT 1 FROM connection WHERE organization_id = $1 AND status = 'active' LIMIT 1`,
      [organizationId],
    );
    return (r.rowCount ?? 0) > 0;
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
      autoStart: !preconfigured && !dismissed && !complete,
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
