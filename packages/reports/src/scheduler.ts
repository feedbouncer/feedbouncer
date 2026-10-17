// Creates each workspace's weekly report once its local Monday SEND_HOUR_LOCAL:00 has passed.
// Logs ids, counts and week keys only.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';
import { CATCHUP_HOURS, SCHEDULER_BATCH, SEND_HOUR_LOCAL } from './constants.js';
import { reportPeriod } from './period.js';
import { rankTopAds } from './rank.js';
import { computeWeeklyStats } from './stats.js';

const HOUR_MS = 3_600_000;

// The reportPeriod expressions, per organization: m is the local Monday 00:00 ending the week.
// $1 now, $2 SEND_HOUR_LOCAL, $3 batch.
const DUE_SQL = `
  WITH o AS (
    SELECT id, timezone, date_trunc('week', $1::timestamptz AT TIME ZONE timezone) AS m
      FROM organization)
  SELECT o.id, o.timezone, to_char(o.m - interval '7 days', 'YYYY-MM-DD') AS week_start
    FROM o
   WHERE (o.m + make_interval(hours => $2)) AT TIME ZONE o.timezone <= $1
     AND NOT EXISTS (SELECT 1 FROM weekly_report r
                      WHERE r.organization_id = o.id AND r.week_start = (o.m - interval '7 days')::date)
   ORDER BY (o.m + make_interval(hours => $2)) AT TIME ZONE o.timezone, o.id
   LIMIT $3`;

// Granted to one scheduler per organization; also re-checks the report under this snapshot.
const LOCK_SQL = `
  SELECT pg_try_advisory_xact_lock(hashtextextended('weekly-report:' || $1::text, 0))
         AND NOT EXISTS (SELECT 1 FROM weekly_report WHERE organization_id = $1::uuid AND week_start = $2::date)
         AS go`;

const INSERT_SQL = `
  INSERT INTO weekly_report
    (organization_id, week_start, timezone, period_start, period_end, status, payload, computed_at)
  VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (organization_id, week_start) DO NOTHING
  RETURNING id`;

// Global Constraints › Recipients; the dispatcher re-checks the same four at send time.
const DELIVERIES_SQL = `
  INSERT INTO weekly_report_delivery (organization_id, report_id, user_id, next_attempt_at)
  SELECT m.organization_id, $2, m.user_id, $3
    FROM membership m
    JOIN app_user u ON u.id = m.user_id
   WHERE m.organization_id = $1 AND m.role IN ('owner', 'admin') AND u.email_verified
     AND NOT EXISTS (SELECT 1 FROM report_subscription s
                      WHERE s.organization_id = $1 AND s.user_id = m.user_id AND s.status = 'unsubscribed')
  ON CONFLICT (report_id, user_id) DO NOTHING`;

type Outcome = 'created' | 'quiet' | 'missed' | null;

interface Due {
  id: string;
  timezone: string;
  week_start: string;
}

export class WeeklyReportScheduler {
  private readonly now: () => Date;
  private readonly batch: number;

  constructor(
    private readonly d: { pool: pg.Pool; log: Logger; now?: () => Date; batch?: number },
  ) {
    this.now = d.now ?? (() => new Date());
    this.batch = d.batch ?? SCHEDULER_BATCH;
  }

  async tick(): Promise<{ created: number; quiet: number; missed: number; failed: number }> {
    const now = this.now();
    const result = { created: 0, quiet: 0, missed: 0, failed: 0 };
    const due = await this.d.pool.query<Due>(DUE_SQL, [now, SEND_HOUR_LOCAL, this.batch]);
    for (const org of due.rows) {
      try {
        // One snapshot per organization, so every metric in the report agrees.
        const outcome = await withTransaction(this.d.pool, (c) => this.create(c, org, now), {
          isolation: 'repeatable read',
        });
        if (outcome) result[outcome] += 1;
      } catch (err) {
        result.failed += 1;
        this.d.log.error('reports.compute_failed', {
          organizationId: org.id,
          weekStart: org.week_start,
          error: err instanceof Error ? err.name : 'NonError',
        });
      }
    }
    return result;
  }

  private async create(c: pg.ClientBase, org: Due, now: Date): Promise<Outcome> {
    const lock = await c.query<{ go: boolean }>(LOCK_SQL, [org.id, org.week_start]);
    if (!lock.rows[0]!.go) return null;
    const p = await reportPeriod(c, org.timezone, now);
    const insert = async (status: 'queued' | 'skipped_quiet' | 'missed', payload: object | null) =>
      (
        await c.query<{ id: string }>(INSERT_SQL, [
          org.id,
          p.weekStart,
          p.timezone,
          p.start,
          p.end,
          status,
          payload,
          now,
        ])
      ).rows[0]?.id;
    const fields = { organizationId: org.id, weekStart: p.weekStart };

    if (now.getTime() > p.dueAt.getTime() + CATCHUP_HOURS * HOUR_MS) {
      if (!(await insert('missed', null))) return null;
      this.d.log.warn('reports.missed', fields);
      return 'missed';
    }
    const stats = await computeWeeklyStats(c, org.id, p, now);
    stats.ads = rankTopAds(stats.ads);
    if (stats.processed === 0) {
      if (!(await insert('skipped_quiet', null))) return null;
      this.d.log.info('reports.skipped_quiet', fields);
      return 'quiet';
    }
    const reportId = await insert('queued', stats);
    if (!reportId) return null;
    const deliveries = await c.query(DELIVERIES_SQL, [org.id, reportId, now]);
    this.d.log.info('reports.created', { ...fields, reportId, deliveries: deliveries.rowCount });
    return 'created';
  }
}
