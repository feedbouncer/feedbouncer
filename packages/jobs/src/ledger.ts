// Postgres side of the job queue: the ledger is the source of truth for
// idempotency, retry counters, the worker lease and the dead-letter queue.
// Redis only carries the ledger id. Every write after a claim is guarded by
// lease owner + state, so a worker that lost its lease cannot change the row.
import type pg from 'pg';
import { isPlatform, type Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { DEAD_LETTER_REASONS, type DeadLetterReason } from './failure.js';
import { TRACEPARENT } from '@feedbouncer/service-runtime';
import { UUID } from './keys.js';

export type LedgerState = 'queued' | 'completed' | 'dead_lettered' | 'resolved';

export interface LedgerRow {
  readonly id: string;
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly state: LedgerState;
  readonly failures: number;
  readonly crashes: number;
  readonly deferrals: number;
  readonly deferredMs: number;
  readonly replays: number;
  /** W3C traceparent written by our producer; null for rows from older producers. */
  readonly traceContext: string | null;
}

export interface LedgerDetail extends LedgerRow {
  readonly lastErrorKind: string | null;
  readonly lastErrorCode: string | null;
  readonly result: unknown;
  readonly deadLetterReason: DeadLetterReason | null;
  readonly resolution: string | null;
}

export interface DeadLetterRow extends LedgerRow {
  readonly reason: DeadLetterReason;
  readonly resolution: string | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorCode: string | null;
  readonly firstFailedAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly deadLetteredAt: Date;
  readonly createdAt: Date;
}

export type ClaimResult =
  | { readonly status: 'claimed'; readonly row: LedgerRow; readonly waitMs: number | null }
  | { readonly status: 'settled'; readonly state: Exclude<LedgerState, 'queued'> }
  | { readonly status: 'busy'; readonly retryInMs: number }
  | { readonly status: 'missing' };

export interface InsertInput {
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly jobType: string;
  readonly idempotencyKey: string;
  readonly payloadJson: string;
  readonly ttlMs: number;
  readonly traceContext: string | null;
}

export type InsertResult =
  | { readonly status: 'inserted'; readonly id: string }
  | { readonly status: 'exists'; readonly id: string; readonly state: LedgerState }
  | { readonly status: 'no_connection' };

export interface DlqFilter {
  readonly platform?: Platform;
  readonly organizationId?: string;
  readonly reason?: DeadLetterReason;
  readonly states?: readonly ('dead_lettered' | 'resolved')[];
  readonly since?: Date;
  readonly ids?: readonly string[];
  readonly limit: number;
}

/** Replay always targets dead-lettered rows, so it takes no `states`. */
export type ReplayFilter = Omit<DlqFilter, 'states'>;

export interface Requeued {
  readonly id: string;
  readonly platform: Platform;
  readonly jobType: string;
  readonly idempotencyKey: string;
}

export interface DeadLetterInput {
  readonly reason: DeadLetterReason;
  readonly resolution: string | null;
  readonly errorKind: string;
  readonly errorCode: string;
  readonly countsAsFailure: boolean;
  readonly retentionMs: number;
}

/** What the runner needs from the ledger. */
export interface JobLedgerPort {
  claim(id: string, owner: string, leaseMs: number): Promise<ClaimResult>;
  complete(id: string, owner: string, resultJson: string): Promise<boolean>;
  recordRetry(
    id: string,
    owner: string,
    f: { kind: string; code: string },
    delayMs: number,
  ): Promise<boolean>;
  recordDeferral(id: string, owner: string, code: string, delayMs: number): Promise<boolean>;
  deadLetter(id: string, owner: string, d: DeadLetterInput): Promise<boolean>;
}

const ROW_COLS = [
  'id',
  'organization_id',
  'brand_id',
  'connection_id',
  'platform',
  'job_type',
  'idempotency_key',
  'payload',
  'state',
  'failures',
  'crashes',
  'deferrals',
  'deferred_ms',
  'replays',
  'trace_context',
] as const;
const ROW = ROW_COLS.join(', ');
const ROW_J = ROW_COLS.map((c) => `j.${c}`).join(', ');

const INSERT_SQL = `
  WITH conn AS (
    SELECT organization_id, brand_id, id, platform FROM connection
     WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = $4),
  ins AS (
    INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type,
                            idempotency_key, payload, expires_at, trace_context)
    SELECT organization_id, brand_id, id, platform, $5, $6, $7::jsonb,
           now() + ($8::bigint * interval '1 millisecond'), $9::text
      FROM conn
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id)
  SELECT (SELECT count(*)::int FROM conn) AS connections, (SELECT id FROM ins) AS inserted_id`;

const EXISTING_SQL = `SELECT id, state FROM job_ledger WHERE organization_id = $1 AND idempotency_key = $2`;

// A claim taking over an abandoned lease counts one crash. A claim more than
// 1 s before next_run_at is refused (a crash between recordRetry and
// moveToDelayed must not skip the backoff).
const CLAIM_SQL = `
  UPDATE job_ledger j SET
    crashes = j.crashes + CASE WHEN j.lease_owner IS NOT NULL THEN 1 ELSE 0 END,
    lease_owner = $2, lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
    next_run_at = NULL
  FROM (SELECT id, next_run_at AS due_at FROM job_ledger WHERE id = $1) prev
  WHERE j.id = $1 AND prev.id = j.id AND j.state = 'queued'
    AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now())
    AND (j.next_run_at IS NULL OR j.next_run_at <= now() + interval '1 second')
  RETURNING ${ROW_J},
    CASE
      WHEN prev.due_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - prev.due_at)) * 1000)
      WHEN j.failures = 0 AND j.crashes = 0 AND j.deferrals = 0 AND j.replays = 0
        THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - j.created_at)) * 1000)
    END AS wait_ms`;

const PROBE_SQL = `
  SELECT state,
    GREATEST(
      COALESCE(EXTRACT(EPOCH FROM (lease_expires_at - now())) * 1000, 0),
      COALESCE(EXTRACT(EPOCH FROM (next_run_at - now())) * 1000, 0))::bigint AS wait_ms
  FROM job_ledger WHERE id = $1`;

const COMPLETE_SQL = `
  UPDATE job_ledger SET state = 'completed', completed_at = now(), result = $3::jsonb,
    lease_owner = NULL, lease_expires_at = NULL
  WHERE id = $1 AND lease_owner = $2 AND state = 'queued'`;

const RETRY_SQL = `
  UPDATE job_ledger SET failures = failures + 1, last_error_kind = $3, last_error_code = $4,
    first_failed_at = COALESCE(first_failed_at, now()), last_failed_at = now(),
    lease_owner = NULL, lease_expires_at = NULL,
    next_run_at = now() + ($5::bigint * interval '1 millisecond')
  WHERE id = $1 AND lease_owner = $2 AND state = 'queued'`;

// A rate limit is not a failure: failure timestamps are untouched.
const DEFER_SQL = `
  UPDATE job_ledger SET deferrals = deferrals + 1, deferred_ms = deferred_ms + $4::bigint,
    last_error_kind = 'rate_limited', last_error_code = $3,
    lease_owner = NULL, lease_expires_at = NULL,
    next_run_at = now() + ($4::bigint * interval '1 millisecond')
  WHERE id = $1 AND lease_owner = $2 AND state = 'queued'`;

const DEAD_LETTER_SQL = `
  UPDATE job_ledger SET
    state = CASE WHEN $4::text IS NULL THEN 'dead_lettered' ELSE 'resolved' END,
    dead_letter_reason = $3, resolution = $4::text, last_error_kind = $5, last_error_code = $6,
    failures = failures + CASE WHEN $7::boolean THEN 1 ELSE 0 END,
    first_failed_at = CASE WHEN $7::boolean THEN COALESCE(first_failed_at, now()) ELSE first_failed_at END,
    last_failed_at = CASE WHEN $7::boolean THEN now() ELSE last_failed_at END,
    dead_lettered_at = now(), lease_owner = NULL, lease_expires_at = NULL, next_run_at = NULL,
    expires_at = GREATEST(expires_at, now() + ($8::bigint * interval '1 millisecond'))
  WHERE id = $1 AND lease_owner = $2 AND state = 'queued'`;

// MATERIALIZED, as in STALE_SQL, so LIMIT holds.
// `where` comes only from buildFilter(): positional placeholders, never values.
const REPLAY_SQL = (where: string) => `
  WITH picked AS MATERIALIZED (
    SELECT id FROM job_ledger WHERE state = 'dead_lettered'${where}
     ORDER BY dead_lettered_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
  UPDATE job_ledger SET state = 'queued', replays = replays + 1,
    failures = 0, crashes = 0, deferrals = 0, deferred_ms = 0,
    dead_letter_reason = NULL, dead_lettered_at = NULL, resolution = NULL, next_run_at = NULL,
    expires_at = GREATEST(expires_at, now() + ($1::bigint * interval '1 millisecond'))
  WHERE id IN (SELECT id FROM picked)
  RETURNING id, platform, job_type, idempotency_key`;

// 'oldest' is the order replay takes rows in, so a dry run previews what replay will touch.
const LIST_SQL = (where: string, limitParam: number, order: 'ASC' | 'DESC') => `
  SELECT ${ROW}, dead_letter_reason, resolution, last_error_kind, last_error_code,
         first_failed_at, last_failed_at, dead_lettered_at, created_at
    FROM job_ledger WHERE state = ANY($1::text[])${where}
   ORDER BY dead_lettered_at ${order}, id LIMIT $${limitParam}`;

// MATERIALIZED: without it the planner may re-run the LIMITed subquery and touch more than $n rows.
const STALE_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM job_ledger
     WHERE state = 'queued'
       AND (lease_expires_at IS NULL OR lease_expires_at < now())
       AND GREATEST(COALESCE(next_run_at, updated_at), updated_at) < now() - ($1::bigint * interval '1 millisecond')
     ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED)
  UPDATE job_ledger SET updated_at = now()
  WHERE id IN (SELECT id FROM picked)
  RETURNING id, platform, job_type, idempotency_key`;

const PURGE_SQL = `
  WITH picked AS MATERIALIZED (
    SELECT id FROM job_ledger WHERE state <> 'queued' AND expires_at < now()
     ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
  DELETE FROM job_ledger
  WHERE id IN (SELECT id FROM picked)
    AND state <> 'queued' AND expires_at < now()`;

const GET_SQL = `
  SELECT ${ROW}, last_error_kind, last_error_code, result, dead_letter_reason, resolution
    FROM job_ledger WHERE id = $1`;

const DLQ_STATES = ['dead_lettered', 'resolved'] as const;
const MAX_LIMIT = 10_000;

/** Millisecond inputs reach bigint columns: round up, refuse NaN, Infinity and negatives. */
function ms(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`invalid duration: ${field}`);
  }
  return Math.ceil(value);
}

const bad = (field: string): never => {
  throw new RangeError(`invalid filter: ${field}`);
};

/**
 * Validates every value, then emits only placeholders. Offending values are
 * never echoed back in the error.
 */
function buildFilter(f: DlqFilter, firstParam: number): { where: string; params: unknown[] } {
  if (f.platform !== undefined && !isPlatform(f.platform)) bad('platform');
  if (f.organizationId !== undefined && !UUID.test(f.organizationId)) bad('organizationId');
  if (f.reason !== undefined && !DEAD_LETTER_REASONS.includes(f.reason)) bad('reason');
  if (f.states !== undefined && !f.states.every((s) => DLQ_STATES.includes(s))) bad('states');
  if (f.since !== undefined && !(f.since instanceof Date && Number.isFinite(f.since.getTime()))) {
    bad('since');
  }
  if (f.ids !== undefined && !f.ids.every((i) => typeof i === 'string' && UUID.test(i))) bad('ids');
  if (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > MAX_LIMIT) bad('limit');

  let where = '';
  const params: unknown[] = [];
  const add = (clause: (n: number) => string, value: unknown): void => {
    params.push(value);
    where += clause(firstParam + params.length - 1);
  };
  if (f.platform !== undefined) add((n) => ` AND platform = $${n}`, f.platform);
  if (f.organizationId !== undefined) {
    add((n) => ` AND organization_id = $${n}::uuid`, f.organizationId);
  }
  if (f.reason !== undefined) add((n) => ` AND dead_letter_reason = $${n}`, f.reason);
  if (f.since !== undefined) add((n) => ` AND dead_lettered_at >= $${n}`, f.since);
  if (f.ids !== undefined) add((n) => ` AND id = ANY($${n}::uuid[])`, [...f.ids]);
  return { where, params };
}

interface BaseRecord {
  id: string;
  organization_id: string;
  brand_id: string;
  connection_id: string;
  platform: Platform;
  job_type: string;
  idempotency_key: string;
  payload: unknown;
  state: LedgerState;
  failures: number;
  crashes: number;
  deferrals: number;
  deferred_ms: string | number;
  replays: number;
  trace_context: string | null;
}

function toRow(r: BaseRecord): LedgerRow {
  return {
    id: r.id,
    scope: {
      organizationId: r.organization_id,
      brandId: r.brand_id,
      connectionId: r.connection_id,
    },
    platform: r.platform,
    jobType: r.job_type,
    idempotencyKey: r.idempotency_key,
    payload: r.payload,
    state: r.state,
    failures: r.failures,
    crashes: r.crashes,
    deferrals: r.deferrals,
    deferredMs: Number(r.deferred_ms),
    replays: r.replays,
    traceContext: r.trace_context,
  };
}

interface RequeuedRecord {
  id: string;
  platform: Platform;
  job_type: string;
  idempotency_key: string;
}

const toRequeued = (r: RequeuedRecord): Requeued => ({
  id: r.id,
  platform: r.platform,
  jobType: r.job_type,
  idempotencyKey: r.idempotency_key,
});

export interface QueueStat {
  readonly platform: Platform;
  readonly depth: number;
  readonly oldestAgeMs: number;
}

const QUEUE_STATS_SQL = `
  SELECT platform, count(*)::int AS depth,
         GREATEST(0, EXTRACT(EPOCH FROM (now() - min(created_at))) * 1000) AS oldest_ms
    FROM job_ledger WHERE state = 'queued' GROUP BY platform`;

export class PgJobLedger implements JobLedgerPort {
  constructor(private readonly pool: pg.Pool) {}

  async insert(i: InsertInput): Promise<InsertResult> {
    const params = [
      i.scope.organizationId,
      i.scope.brandId,
      i.scope.connectionId,
      i.platform,
      i.jobType,
      i.idempotencyKey,
      i.payloadJson,
      ms(i.ttlMs, 'ttlMs'),
      i.traceContext !== null && TRACEPARENT.test(i.traceContext) ? i.traceContext : null,
    ];
    // The conflicting row can be purged between the two statements; one retry covers it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { rows } = await this.pool.query<{ connections: number; inserted_id: string | null }>(
        INSERT_SQL,
        params,
      );
      const r = rows[0]!;
      if (r.connections === 0) return { status: 'no_connection' };
      if (r.inserted_id !== null) return { status: 'inserted', id: r.inserted_id };
      const existing = await this.pool.query<{ id: string; state: LedgerState }>(EXISTING_SQL, [
        i.scope.organizationId,
        i.idempotencyKey,
      ]);
      const e = existing.rows[0];
      if (e) return { status: 'exists', id: e.id, state: e.state };
    }
    throw new Error('job ledger insert did not settle');
  }

  async claim(id: string, owner: string, leaseMs: number): Promise<ClaimResult> {
    const claimed = await this.pool.query<BaseRecord & { wait_ms: string | number | null }>(
      CLAIM_SQL,
      [id, owner, ms(leaseMs, 'leaseMs')],
    );
    const r = claimed.rows[0];
    if (r) {
      return {
        status: 'claimed',
        row: toRow(r),
        waitMs: r.wait_ms === null ? null : Number(r.wait_ms),
      };
    }
    const probe = await this.pool.query<{ state: LedgerState; wait_ms: string }>(PROBE_SQL, [id]);
    const p = probe.rows[0];
    if (!p) return { status: 'missing' };
    if (p.state !== 'queued') return { status: 'settled', state: p.state };
    return { status: 'busy', retryInMs: Math.max(Number(p.wait_ms), 250) };
  }

  /** Read-only snapshot for scrape-time gauges; statement_timeout bounds a stuck query server-side. */
  async queueStats(timeoutMs = 5_000): Promise<QueueStat[]> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
      const { rows } = await client.query<{
        platform: Platform;
        depth: number;
        oldest_ms: string | number;
      }>(QUEUE_STATS_SQL);
      await client.query('COMMIT');
      return rows.map((r) => ({
        platform: r.platform,
        depth: r.depth,
        oldestAgeMs: Number(r.oldest_ms),
      }));
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  async complete(id: string, owner: string, resultJson: string): Promise<boolean> {
    const r = await this.pool.query(COMPLETE_SQL, [id, owner, resultJson]);
    return r.rowCount === 1;
  }

  async recordRetry(
    id: string,
    owner: string,
    f: { kind: string; code: string },
    delayMs: number,
  ): Promise<boolean> {
    const r = await this.pool.query(RETRY_SQL, [id, owner, f.kind, f.code, ms(delayMs, 'delayMs')]);
    return r.rowCount === 1;
  }

  async recordDeferral(id: string, owner: string, code: string, delayMs: number): Promise<boolean> {
    const r = await this.pool.query(DEFER_SQL, [id, owner, code, ms(delayMs, 'delayMs')]);
    return r.rowCount === 1;
  }

  async deadLetter(id: string, owner: string, d: DeadLetterInput): Promise<boolean> {
    const r = await this.pool.query(DEAD_LETTER_SQL, [
      id,
      owner,
      d.reason,
      d.resolution,
      d.errorKind,
      d.errorCode,
      d.countsAsFailure,
      ms(d.retentionMs, 'retentionMs'),
    ]);
    return r.rowCount === 1;
  }

  async replay(filter: ReplayFilter, dedupWindowMs: number): Promise<Requeued[]> {
    const { where, params } = buildFilter(filter, 3);
    const { rows } = await this.pool.query<RequeuedRecord>(REPLAY_SQL(where), [
      ms(dedupWindowMs, 'dedupWindowMs'),
      filter.limit,
      ...params,
    ]);
    return rows.map(toRequeued);
  }

  async listDeadLetters(
    filter: DlqFilter,
    order: 'newest' | 'oldest' = 'newest',
  ): Promise<DeadLetterRow[]> {
    const { where, params } = buildFilter(filter, 2);
    const states = filter.states ?? ['dead_lettered'];
    const { rows } = await this.pool.query<
      BaseRecord & {
        dead_letter_reason: DeadLetterReason;
        resolution: string | null;
        last_error_kind: string | null;
        last_error_code: string | null;
        first_failed_at: Date | null;
        last_failed_at: Date | null;
        dead_lettered_at: Date;
        created_at: Date;
      }
    >(LIST_SQL(where, 2 + params.length, order === 'oldest' ? 'ASC' : 'DESC'), [
      states,
      ...params,
      filter.limit,
    ]);
    return rows.map((r) => ({
      ...toRow(r),
      reason: r.dead_letter_reason,
      resolution: r.resolution,
      lastErrorKind: r.last_error_kind,
      lastErrorCode: r.last_error_code,
      firstFailedAt: r.first_failed_at,
      lastFailedAt: r.last_failed_at,
      deadLetteredAt: r.dead_lettered_at,
      createdAt: r.created_at,
    }));
  }

  async staleQueued(staleAfterMs: number, limit: number): Promise<Requeued[]> {
    const { rows } = await this.pool.query<RequeuedRecord>(STALE_SQL, [
      ms(staleAfterMs, 'staleAfterMs'),
      limit,
    ]);
    return rows.map(toRequeued);
  }

  async purgeExpired(limit: number): Promise<number> {
    const r = await this.pool.query(PURGE_SQL, [limit]);
    return r.rowCount ?? 0;
  }

  async get(id: string): Promise<LedgerDetail | null> {
    const { rows } = await this.pool.query<
      BaseRecord & {
        last_error_kind: string | null;
        last_error_code: string | null;
        result: unknown;
        dead_letter_reason: DeadLetterReason | null;
        resolution: string | null;
      }
    >(GET_SQL, [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      ...toRow(r),
      lastErrorKind: r.last_error_kind,
      lastErrorCode: r.last_error_code,
      result: r.result,
      deadLetterReason: r.dead_letter_reason,
      resolution: r.resolution,
    };
  }
}
