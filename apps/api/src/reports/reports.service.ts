import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  DASHBOARD_LOOKBACK_WEEKS,
  PgReportSubscriptions,
  WEEK_START_RE,
  computeWeeklyStats,
  periodForWeek,
  rankTopAds,
  reportPeriod,
  type ReportPeriod,
  type ReportSubscriptionEntry,
  type WeeklyStats,
} from '@feedbouncer/reports';
import type { AuthRateLimits } from '../auth/rate-limit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { DEPS, RATE_LIMITS } from '../tokens.js';

export interface WeeklyReportDto {
  weekStart: string;
  timezone: string;
  source: 'snapshot' | 'live';
  stats: WeeklyStats;
  /** The organization's report weeks, newest first. */
  weeks: string[];
}

const WEEK_MS = 7 * 86_400_000;

/** The period of a requested week: a Monday from the last complete week back DASHBOARD_LOOKBACK_WEEKS. */
async function requestedPeriod(
  c: pg.ClientBase,
  last: ReportPeriod,
  week: string,
): Promise<ReportPeriod> {
  const day = Date.parse(`${week}T00:00:00Z`);
  const oldest =
    Date.parse(`${last.weekStart}T00:00:00Z`) - (DASHBOARD_LOOKBACK_WEEKS - 1) * WEEK_MS;
  // Rejects impossible dates (2026-02-30) here rather than as a Postgres error.
  const real =
    WEEK_START_RE.test(week) && !Number.isNaN(day) && new Date(day).toISOString().startsWith(week);
  const p =
    real && day >= oldest && week <= last.weekStart
      ? await periodForWeek(c, last.timezone, week)
      : null;
  if (!p) throw new ApiError(400, 'invalid_week');
  return p;
}

@Injectable()
export class ReportsService {
  readonly #subscriptions: PgReportSubscriptions;

  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(RATE_LIMITS) private readonly limits: AuthRateLimits,
  ) {
    this.#subscriptions = new PgReportSubscriptions(deps.pool, deps.env.encryption);
  }

  /** `week` defaults to the last complete week. One read-only snapshot, so every number agrees. */
  weekly(org: OrgContext, week: string | undefined): Promise<WeeklyReportDto> {
    return withTransaction(
      this.deps.pool,
      async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        const orgId = org.organizationId;
        const o = await c.query<{ timezone: string }>(
          'SELECT timezone FROM organization WHERE id = $1',
          [orgId],
        );
        if (!o.rows[0]) throw notFound();
        const now = new Date();
        const last = await reportPeriod(c, o.rows[0].timezone, now);
        const p = week === undefined ? last : await requestedPeriod(c, last, week);
        const weeks = await this.weeks(c, orgId);
        const snapshot = await c.query<{ timezone: string; payload: WeeklyStats }>(
          `SELECT timezone, payload FROM weekly_report
            WHERE organization_id = $1 AND week_start = $2::date AND status = 'queued'`,
          [orgId, p.weekStart],
        );
        const s = snapshot.rows[0];
        if (s)
          return {
            weekStart: p.weekStart,
            timezone: s.timezone,
            source: 'snapshot',
            stats: s.payload,
            weeks,
          };
        // Computed as of the due time at the latest, as the snapshot would have been.
        const asOf = new Date(Math.min(now.getTime(), p.dueAt.getTime()));
        const stats = await computeWeeklyStats(c, orgId, p, asOf);
        stats.ads = rankTopAds(stats.ads);
        return { weekStart: p.weekStart, timezone: p.timezone, source: 'live', stats, weeks };
      },
      { isolation: 'repeatable read' },
    );
  }

  listSubscriptions(userId: string): Promise<ReportSubscriptionEntry[]> {
    return this.#subscriptions.listForUser(userId);
  }

  async setSubscription(userId: string, orgId: string, subscribed: boolean): Promise<void> {
    const r = await this.#subscriptions.setForUser(userId, orgId, subscribed);
    if (r.status === 'not_found') throw notFound();
  }

  /** Public one-click link: the same answer shape for every token, valid or not. */
  async unsubscribe(ip: string, token: string) {
    await this.limits.consumePublicRecipient(ip);
    return this.#subscriptions.unsubscribeByToken(token);
  }

  private async weeks(c: pg.ClientBase, orgId: string): Promise<string[]> {
    const r = await c.query<{ week_start: string }>(
      `SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start FROM weekly_report
        WHERE organization_id = $1 ORDER BY week_start DESC LIMIT $2`,
      [orgId, DASHBOARD_LOOKBACK_WEEKS],
    );
    return r.rows.map((w) => w.week_start);
  }
}
