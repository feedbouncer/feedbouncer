import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  RETENTION_CATEGORIES,
  effectiveDays,
  purgeDays,
  retentionWarnings,
  type RetentionCategory,
  type RetentionDays,
  type RetentionSettings,
  type RetentionWarning,
} from './settings.js';

export interface RetentionRunSummary {
  id: string;
  status: 'running' | 'done' | 'failed' | 'partial';
  startedAt: Date;
  finishedAt: Date | null;
  counts: Record<string, number>;
  held: string[];
  skippedPendingReview: number;
}

export interface RetentionStatus {
  settings: RetentionSettings;
  effective: Record<RetentionCategory, RetentionDays>;
  warnings: RetentionWarning[];
  updatedAt: Date;
  lastRun: RetentionRunSummary | null;
}

/**
 * A large-deletion confirmation holds only while its category keeps the period it was
 * given for: once another period applies, it is deleted, so changing back needs a new one.
 */
export async function forgetStaleConfirmations(
  db: pg.Pool | pg.PoolClient,
  s: RetentionSettings,
): Promise<void> {
  const days = purgeDays(s);
  const current = RETENTION_CATEGORIES.map((c) => (days[c] === 'forever' ? null : days[c]));
  await db.query(
    `DELETE FROM retention_confirmation r
      USING unnest($1::text[], $2::int[]) AS cur(category, days)
      WHERE r.category = cur.category AND r.days IS DISTINCT FROM cur.days`,
    [RETENTION_CATEGORIES, current],
  );
}

/**
 * Records the worker's configuration so the API and CLI can show it without reading worker
 * env, and drops the confirmations it no longer honours.
 */
export async function publishRetentionStatus(pool: pg.Pool, s: RetentionSettings): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO retention_status (id, settings, effective, warnings)
       VALUES (1, $1::jsonb, $2::jsonb, $3::text[])
       ON CONFLICT (id) DO UPDATE
         SET settings = EXCLUDED.settings, effective = EXCLUDED.effective, warnings = EXCLUDED.warnings`,
      [JSON.stringify(s), JSON.stringify(effectiveDays(s)), retentionWarnings(s)],
    );
    await forgetStaleConfirmations(tx, s);
  });
}

interface StatusRow {
  settings: RetentionStatus['settings'];
  effective: RetentionStatus['effective'];
  warnings: RetentionWarning[];
  updated_at: Date;
}

interface RunRow {
  id: string;
  status: RetentionRunSummary['status'];
  started_at: Date;
  finished_at: Date | null;
  counts: Record<string, number>;
  held: string[];
  skipped_pending_review: number;
}

export interface OrgRetentionStatus {
  settings: RetentionSettings;
  effective: Record<RetentionCategory, RetentionDays>;
  warnings: RetentionWarning[];
  updatedAt: Date;
  /** The organization's latest purge; its counts cover only its own rows. */
  lastPurge: { at: Date; counts: Record<string, number> } | null;
  /** Categories held for this organization's rows: the period still applies and no one has confirmed it. */
  held: { at: Date; category: string; days: number }[];
}

/** The settings plus the organization's own purge and hold audit events; nothing from other organizations. */
export async function readOrgRetentionStatus(
  pool: pg.Pool,
  organizationId: string,
): Promise<OrgRetentionStatus> {
  const [status, purged, held] = await Promise.all([
    pool.query<StatusRow>(
      'SELECT settings, effective, warnings, updated_at FROM retention_status WHERE id = 1',
    ),
    pool.query<{ created_at: Date; counts: Record<string, number> }>(
      `SELECT created_at, details->'counts' AS counts FROM audit_event
        WHERE organization_id = $1 AND action = 'retention.purged'
        ORDER BY sequence DESC LIMIT 1`,
      [organizationId],
    ),
    pool.query<{ created_at: Date; category: string; days: number }>(
      `SELECT DISTINCT ON (a.details->>'category')
              a.created_at, a.details->>'category' AS category, (a.details->>'days')::int AS days
         FROM audit_event a
        WHERE a.organization_id = $1 AND a.action = 'retention.held'
          AND NOT EXISTS (
            SELECT 1 FROM retention_confirmation r
             WHERE r.category = a.details->>'category' AND r.days = (a.details->>'days')::int)
        ORDER BY a.details->>'category', a.sequence DESC`,
      [organizationId],
    ),
  ]);
  const row = status.rows[0];
  if (!row) throw new Error('retention_status row is missing');
  const last = purged.rows[0];
  return {
    settings: row.settings,
    effective: row.effective,
    warnings: row.warnings,
    updatedAt: row.updated_at,
    lastPurge: last ? { at: last.created_at, counts: last.counts } : null,
    held: held.rows
      .filter((h) => purgeDays(row.settings)[h.category as RetentionCategory] === h.days)
      .map((h) => ({ at: h.created_at, category: h.category, days: h.days }))
      .sort((a, b) => b.at.getTime() - a.at.getTime()),
  };
}

export async function readRetentionStatus(pool: pg.Pool): Promise<RetentionStatus> {
  const [status, run] = await Promise.all([
    pool.query<StatusRow>(
      'SELECT settings, effective, warnings, updated_at FROM retention_status WHERE id = 1',
    ),
    pool.query<RunRow>(
      `SELECT id, status, started_at, finished_at, counts, held, skipped_pending_review
       FROM retention_run WHERE finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    ),
  ]);
  const row = status.rows[0];
  if (!row) throw new Error('retention_status row is missing');
  const last = run.rows[0];
  return {
    settings: row.settings,
    effective: row.effective,
    warnings: row.warnings,
    updatedAt: row.updated_at,
    lastRun: last
      ? {
          id: last.id,
          status: last.status,
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          counts: last.counts,
          held: last.held,
          skippedPendingReview: last.skipped_pending_review,
        }
      : null,
  };
}
