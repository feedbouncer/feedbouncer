import type pg from 'pg';
import {
  effectiveDays,
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

/** Records the worker's configuration so the API and CLI can show it without reading worker env. */
export async function publishRetentionStatus(pool: pg.Pool, s: RetentionSettings): Promise<void> {
  await pool.query(
    `INSERT INTO retention_status (id, settings, effective, warnings)
     VALUES (1, $1::jsonb, $2::jsonb, $3::text[])
     ON CONFLICT (id) DO UPDATE
       SET settings = EXCLUDED.settings, effective = EXCLUDED.effective, warnings = EXCLUDED.warnings`,
    [JSON.stringify(s), JSON.stringify(effectiveDays(s)), retentionWarnings(s)],
  );
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
