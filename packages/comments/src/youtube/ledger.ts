// The Postgres YouTube quota ledger, keyed by the Pacific day. Every call is
// reserved (a 'sent' row) before it is sent and settled after it; an unsettled
// row still counts, so spend is never under-counted. Reservations for one day
// are serialised by a transaction-scoped advisory lock, so concurrent replicas
// can never overspend the connection budget or the project cap.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ConnectorError,
  type Clock,
  type QuotaMeter,
  type QuotaPurpose,
  type QuotaTicket,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { budgetView, type BudgetInputs } from './budget.js';
import { nextPacificMidnight, pacificDayKey } from './quota-day.js';
import type { PgYouTubeSettings } from './settings.js';

export interface QuotaLedgerLog {
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface QuotaLedgerDeps {
  pool: pg.Pool;
  clock: Clock;
  /** YOUTUBE_PROJECT_DAILY_QUOTA. */
  projectQuota: number;
  /** YOUTUBE_PROJECT_HEADROOM_UNITS, kept free for other tools on the same project. */
  projectHeadroom: number;
  settings: PgYouTubeSettings;
  log: QuotaLedgerLog;
}

export interface DailyTotal {
  method: string;
  purpose: QuotaPurpose;
  units: number;
  calls: number;
}

const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

type Queryable = Pick<pg.ClientBase, 'query'>;

interface Sums {
  project_spent: number;
  spent: number;
  reads_spent: number;
}

interface Snapshot {
  inputs: BudgetInputs;
  day: string;
}

const scopeParams = (scope: ConnectionScope | null) => [
  scope?.organizationId ?? null,
  scope?.brandId ?? null,
  scope?.connectionId ?? null,
];

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

export class PgYouTubeQuotaLedger {
  constructor(private readonly d: QuotaLedgerDeps) {}

  get projectCapUnits(): number {
    return Math.max(0, this.d.projectQuota - this.d.projectHeadroom);
  }

  /** The meter for one connection's calls. Simulated (dry-run) rows never count as real spend. */
  meterFor(scope: ConnectionScope, opts: { simulated?: boolean } = {}): QuotaMeter {
    return this.#meter(scope, opts.simulated ?? false);
  }

  /** The meter for OAuth-time calls, which have no connection yet: only the project cap applies. */
  projectMeter(): QuotaMeter {
    return this.#meter(null, false);
  }

  /** Today's real (non-simulated) usage for one connection. */
  async usage(scope: ConnectionScope): Promise<BudgetInputs> {
    return (await this.#snapshot(this.d.pool, scope, false, this.d.clock.now())).inputs;
  }

  /** Real spend per method and purpose for one connection on a Pacific day ('YYYY-MM-DD'). */
  async dailyTotals(scope: ConnectionScope, day: string): Promise<DailyTotal[]> {
    const { rows } = await this.d.pool.query<DailyTotal>(
      `SELECT method, purpose, sum(units)::int AS units, count(*)::int AS calls
         FROM youtube_quota_ledger
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND pacific_day = $4::date AND NOT simulated
        GROUP BY method, purpose
        ORDER BY method, purpose`,
      [...scopeParams(scope), day],
    );
    return rows;
  }

  #meter(scope: ConnectionScope | null, simulated: boolean): QuotaMeter {
    return {
      reserve: (req) => this.#reserve(scope, simulated, req),
      settle: (t, o) => this.#settle(scope, t, o),
    };
  }

  async #snapshot(
    q: Queryable,
    scope: ConnectionScope | null,
    simulated: boolean,
    nowMs: number,
  ): Promise<Snapshot> {
    const day = pacificDayKey(nowMs);
    const now = new Date(nowMs);
    // Sequential: `q` may be one pg client inside a transaction, which must not run
    // concurrent queries.
    const sums = await q.query<Sums>(
      `SELECT
           COALESCE(sum(units) FILTER (WHERE NOT simulated), 0)::int AS project_spent,
           COALESCE(sum(units) FILTER (WHERE (NOT simulated OR $5)
             AND organization_id = $2 AND brand_id = $3 AND connection_id = $4), 0)::int AS spent,
           COALESCE(sum(units) FILTER (WHERE (NOT simulated OR $5) AND purpose = 'read'
             AND organization_id = $2 AND brand_id = $3 AND connection_id = $4), 0)::int AS reads_spent
           FROM youtube_quota_ledger
          WHERE pacific_day = $1::date`,
      [day, ...scopeParams(scope), simulated],
    );
    const pause = await q.query(
      'SELECT 1 FROM youtube_quota_pause WHERE pacific_day = $1::date AND resume_at > $2',
      [day, now],
    );
    const budgetUnits = scope ? (await this.d.settings.get(scope, q)).dailyBudgetUnits : 0;
    const s = sums.rows[0]!;
    return {
      day,
      inputs: {
        budgetUnits,
        spentUnits: s.spent,
        readsSpentUnits: s.reads_spent,
        projectCapUnits: this.projectCapUnits,
        projectSpentUnits: s.project_spent,
        paused: (pause.rowCount ?? 0) > 0,
        msUntilReset: nextPacificMidnight(nowMs).getTime() - nowMs,
      },
    };
  }

  async #reserve(
    scope: ConnectionScope | null,
    simulated: boolean,
    req: { method: string; units: number; purpose: QuotaPurpose },
  ): Promise<QuotaTicket> {
    const nowMs = this.d.clock.now();
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('youtube_quota:' || $1))", [
        pacificDayKey(nowMs),
      ]);
      const { inputs, day } = await this.#snapshot(client, scope, simulated, nowMs);
      const refuse = (code: 'quota_budget_exhausted' | 'quota_paused') =>
        new ConnectorError('rate_limited', code, { retryAfterMs: inputs.msUntilReset });
      if (inputs.paused) throw refuse('quota_paused');
      const projectLeft = inputs.projectCapUnits - inputs.projectSpentUnits;
      const v = budgetView(inputs);
      const fits =
        scope === null || req.purpose === 'connect'
          ? req.units <= projectLeft
          : req.purpose === 'read'
            ? req.units <= v.remainingUnits
            : req.units <= v.writeAllowanceUnits;
      if (!fits) throw refuse('quota_budget_exhausted');
      const callKey = randomUUID();
      await client.query(
        `INSERT INTO youtube_quota_ledger
           (call_key, pacific_day, organization_id, brand_id, connection_id,
            method, purpose, units, simulated, created_at)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          callKey,
          day,
          ...scopeParams(scope),
          req.method,
          req.purpose,
          req.units,
          simulated,
          new Date(nowMs),
        ],
      );
      await client.query('COMMIT');
      return { callKey, units: req.units };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent per call key. Failures are logged here because the connector swallows
   * them; the pause insert is retried once, since losing it costs another charged call.
   */
  async #settle(
    scope: ConnectionScope | null,
    t: QuotaTicket,
    o: { ok: boolean; errorCode?: string; quotaExceeded?: boolean },
  ): Promise<void> {
    const nowMs = this.d.clock.now();
    const outcome = o.quotaExceeded ? 'quota_exceeded' : o.ok ? 'ok' : 'error';
    const errorCode =
      o.ok || o.errorCode === undefined || !ERROR_CODE.test(o.errorCode) ? null : o.errorCode;
    let failure: unknown = null;
    try {
      await this.d.pool.query(
        `UPDATE youtube_quota_ledger
            SET outcome = $2, error_code = $3, completed_at = $4
          WHERE call_key = $1 AND outcome = 'sent'
            AND organization_id IS NOT DISTINCT FROM $5
            AND brand_id IS NOT DISTINCT FROM $6`,
        [t.callKey, outcome, errorCode, new Date(nowMs), ...scopeParams(scope).slice(0, 2)],
      );
    } catch (err) {
      failure = err;
      this.d.log.warn('youtube_quota.settle_failed', {
        callKey: t.callKey,
        errorName: errorName(err),
      });
    }
    if (o.quotaExceeded) {
      const insert = () =>
        this.d.pool.query(
          `INSERT INTO youtube_quota_pause (pacific_day, reason, paused_at, resume_at)
           VALUES ($1::date, 'quota_exceeded', $2, $3)
           ON CONFLICT DO NOTHING`,
          [pacificDayKey(nowMs), new Date(nowMs), nextPacificMidnight(nowMs)],
        );
      try {
        await insert();
      } catch (first) {
        this.d.log.warn('youtube_quota.pause_insert_retry', { errorName: errorName(first) });
        try {
          await insert();
        } catch (err) {
          this.d.log.error('youtube_quota.pause_insert_failed', {
            callKey: t.callKey,
            errorName: errorName(err),
          });
          failure ??= err;
        }
      }
    }
    if (failure) throw failure;
  }
}
