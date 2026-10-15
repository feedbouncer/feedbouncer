import type pg from 'pg';
import { notFound } from '../http/errors.js';
import type { BrandScope } from '../tenancy/brand-scope.js';

export interface RerunReport {
  id: string;
  days: number;
  since: string;
  createdAt: string;
  counts: { classified: number; unclassified: number; skipped: number };
}

/** Per-status counts of the classifications a run produced; 404 unless the run is the brand's. */
export async function runCounts(
  pool: pg.Pool,
  scope: BrandScope,
  runId: string,
): Promise<RerunReport> {
  const run = await pool.query<{ id: string; days: number; since: Date; created_at: Date }>(
    `SELECT id, days, since, created_at FROM classifier_run
      WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
    [scope.organizationId, scope.brandId, runId],
  );
  const r = run.rows[0];
  if (!r) throw notFound();
  const counts = await pool.query<{ status: keyof RerunReport['counts']; n: string }>(
    `SELECT status, count(*)::text AS n FROM comment_classification
      WHERE organization_id = $1 AND brand_id = $2 AND trigger_key = 'rerun:' || $3
      GROUP BY status`,
    [scope.organizationId, scope.brandId, runId],
  );
  const out = { classified: 0, unclassified: 0, skipped: 0 };
  for (const c of counts.rows) out[c.status] = Number(c.n);
  return {
    id: r.id,
    days: r.days,
    since: r.since.toISOString(),
    createdAt: r.created_at.toISOString(),
    counts: out,
  };
}

/** A recent run (within the minimum interval) makes a new one wait. */
export async function hasRecentRun(
  c: pg.PoolClient,
  scope: BrandScope,
  minutes: number,
): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM classifier_run
      WHERE organization_id = $1 AND brand_id = $2 AND created_at > now() - make_interval(mins => $3)
      LIMIT 1`,
    [scope.organizationId, scope.brandId, minutes],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function insertRun(
  c: pg.PoolClient,
  scope: BrandScope,
  userId: string,
  days: number,
  since: Date,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO classifier_run (organization_id, brand_id, requested_by_user_id, days, since)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [scope.organizationId, scope.brandId, userId, days, since],
  );
  return r.rows[0]!.id;
}

export async function deleteRun(pool: pg.Pool, scope: BrandScope, runId: string): Promise<void> {
  await pool.query(
    'DELETE FROM classifier_run WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
    [scope.organizationId, scope.brandId, runId],
  );
}

export async function activeConnections(
  pool: pg.Pool,
  scope: BrandScope,
): Promise<{ id: string; platform: string }[]> {
  const r = await pool.query<{ id: string; platform: string }>(
    `SELECT id, platform FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND status = 'active' ORDER BY id`,
    [scope.organizationId, scope.brandId],
  );
  return r.rows;
}

export async function userNames(
  pool: pg.Pool,
  organizationId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const r = await pool.query<{ id: string; display_name: string | null }>(
    `SELECT u.id, u.display_name FROM app_user u
      JOIN membership m ON m.user_id = u.id AND m.organization_id = $1
     WHERE u.id = ANY($2::uuid[])`,
    [organizationId, ids],
  );
  return new Map(r.rows.map((x) => [x.id, x.display_name]));
}
