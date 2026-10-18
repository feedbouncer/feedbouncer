import { parseArgs } from 'node:util';
import { UsageError } from '@feedbouncer/jobs';
import {
  PgHealthReader,
  loadHealthPolicy,
  type HealthReader,
  type HealthStatus,
} from '@feedbouncer/observability';
import type { OpsCommand, Pool } from './ops-context.js';

const DAY_MS = 86_400_000;
const SETTLE_MS = 600_000;
const LOOKBACK_MS = 14 * DAY_MS;
const MAX_CONNECTIONS = 10_000;

export const BETA_STATUS_USAGE = 'usage: pnpm ops beta-status [--json]';

export interface BetaStatusRow {
  organizationId: string;
  connectionId: string;
  platform: string;
  health: HealthStatus;
  reason: string;
  lastSuccessAt: string | null;
  commentsLast24h: number;
  evaluatedLast24h: number;
  unevaluated: number;
  failedImports: number;
  queuedJobs: number;
}

const COLUMNS = [
  'organizationId',
  'connectionId',
  'platform',
  'health',
  'reason',
  'lastSuccessAt',
  'commentsLast24h',
  'evaluatedLast24h',
  'unevaluated',
  'failedImports',
  'queuedJobs',
] as const satisfies readonly (keyof BetaStatusRow)[];

export interface BetaStatusDeps {
  pool: Pool;
  health: HealthReader;
  now: () => Date;
}

async function countsBy(pool: Pool, sql: string, params: unknown[]): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ connection_id: string; n: number }>(sql, params);
  return new Map(rows.map((r) => [r.connection_id, r.n]));
}

/**
 * Per-connection continuity and coverage. Comments imported by backfill are left out of
 * every count: they are history, not live traffic.
 */
export async function betaStatus(
  pool: Pool,
  health: HealthReader,
  now: Date,
): Promise<BetaStatusRow[]> {
  const { rows } = await health.all(MAX_CONNECTIONS);
  const ids = rows.map((r) => r.connectionId);
  const since = new Date(now.getTime() - DAY_MS);
  const settled = new Date(now.getTime() - SETTLE_MS);
  const lookback = new Date(now.getTime() - LOOKBACK_MS);

  const [comments, evaluated, unevaluated, queued] = await Promise.all([
    countsBy(
      pool,
      `SELECT connection_id, count(*)::int AS n FROM comment
        WHERE connection_id = ANY($1::uuid[]) AND ingest_origin <> 'backfill' AND ingested_at >= $2
        GROUP BY connection_id`,
      [ids, since],
    ),
    countsBy(
      pool,
      `SELECT c.connection_id, count(*)::int AS n FROM comment c
        WHERE c.connection_id = ANY($1::uuid[]) AND c.ingest_origin <> 'backfill' AND c.ingested_at >= $2
          AND EXISTS (SELECT 1 FROM rule_evaluation e WHERE e.comment_id = c.id)
        GROUP BY c.connection_id`,
      [ids, since],
    ),
    countsBy(
      pool,
      `SELECT c.connection_id, count(*)::int AS n FROM comment c
        WHERE c.connection_id = ANY($1::uuid[]) AND c.ingest_origin <> 'backfill'
          AND c.platform_state <> 'deleted' AND c.ingested_at >= $2 AND c.ingested_at < $3
          AND NOT EXISTS (SELECT 1 FROM rule_evaluation e WHERE e.comment_id = c.id)
        GROUP BY c.connection_id`,
      [ids, lookback, settled],
    ),
    countsBy(
      pool,
      `SELECT connection_id, count(*)::int AS n FROM job_ledger
        WHERE connection_id = ANY($1::uuid[]) AND state = 'queued' GROUP BY connection_id`,
      [ids],
    ),
  ]);

  return rows.map((r) => ({
    organizationId: r.organizationId,
    connectionId: r.connectionId,
    platform: r.platform,
    health: r.status,
    reason: r.reason,
    lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    commentsLast24h: comments.get(r.connectionId) ?? 0,
    evaluatedLast24h: evaluated.get(r.connectionId) ?? 0,
    unevaluated: unevaluated.get(r.connectionId) ?? 0,
    failedImports: r.failedImports,
    queuedJobs: queued.get(r.connectionId) ?? 0,
  }));
}

const needsAttention = (r: BetaStatusRow) =>
  r.unevaluated > 0 || r.failedImports > 0 || r.health === 'needs_reconnection';

/** Prints the report (ids only). Returns 2 when any connection needs attention. */
export async function runBetaStatus(
  argv: readonly string[],
  deps: BetaStatusDeps,
  out: (line: string) => void,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { json: { type: 'boolean', default: false } },
      strict: true,
    }));
  } catch {
    throw new UsageError('invalid arguments');
  }
  const rows = await betaStatus(deps.pool, deps.health, deps.now());
  if (values.json) out(JSON.stringify(rows, null, 2));
  else {
    const table = [COLUMNS, ...rows.map((r) => COLUMNS.map((k) => String(r[k] ?? '-')))];
    const widths = COLUMNS.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
    for (const row of table)
      out(
        row
          .map((cell, i) => cell.padEnd(widths[i]!))
          .join('  ')
          .trimEnd(),
      );
  }
  return rows.some(needsAttention) ? 2 : 0;
}

export const betaStatusCommand: OpsCommand = (argv, ctx) =>
  runBetaStatus(
    argv,
    {
      pool: ctx.pool(),
      health: new PgHealthReader(ctx.pool(), loadHealthPolicy(ctx.env)),
      now: () => new Date(),
    },
    ctx.out,
  );
