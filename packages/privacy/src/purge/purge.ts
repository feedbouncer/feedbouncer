import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { recordSystemAudit } from '@feedbouncer/actions';
import { commentFingerprint, withRetentionDelete, withTransaction } from '@feedbouncer/db';
import { UUID } from '@feedbouncer/jobs';
import type { Logger } from '@feedbouncer/service-runtime';
import {
  RETENTION_CATEGORIES,
  purgeDays,
  withBuiltinLimit,
  type RetentionCategory,
  type RetentionDays,
  type RetentionSettings,
} from '../settings.js';
import { markRepliesParentRemoved } from '../replies.js';
import { forgetStaleConfirmations, publishRetentionStatus } from '../status.js';
import { PURGE_ORDER, PURGE_TABLES, notPendingReview, type PurgeTable } from './categories.js';
import { withPurgeLock } from './lock.js';

const DAY_MS = 86_400_000;

export interface PurgeCounts {
  byCategory: Record<RetentionCategory, number>;
  skippedPendingReview: number;
  byOrganization: Record<string, Partial<Record<RetentionCategory, number>>>;
}

/** A run that did not get the instance-wide lock has no run row, so no runId. */
export type PurgeResult =
  | {
      runId: string;
      status: 'done' | 'partial';
      held: RetentionCategory[];
      counts: PurgeCounts;
    }
  | { runId: null; status: 'skipped_locked'; held: []; counts: PurgeCounts };

export interface PurgeOptions {
  log: Logger;
  now?: () => Date;
  /** Wall-clock budget for one run; defaults to maxRunMinutes. */
  deadlineMs?: number;
  /** When set, expired subject exports are deleted from here (even if every category is forever). */
  exportDir?: string;
}

export interface CategoryPreview {
  days: RetentionDays;
  eligible: number;
  skippedPendingReview: number;
  confirmed: boolean;
  wouldHold: boolean;
}

/** Thrown by confirmRetention when the days given are not the period currently applied. */
export class RetentionSettingMismatchError extends Error {
  constructor(category: RetentionCategory, current: RetentionDays, days: number) {
    super(`Setting for ${category} is ${current}, not ${days}; nothing confirmed.`);
    this.name = 'RetentionSettingMismatchError';
  }
}

const emptyByCategory = (): Record<RetentionCategory, number> => ({
  comments: 0,
  decisions: 0,
  previews: 0,
  operational: 0,
  audit: 0,
});

const emptyCounts = (): PurgeCounts => ({
  byCategory: emptyByCategory(),
  skippedPendingReview: 0,
  byOrganization: {},
});

/** Cutoff for one table: its category's period, shortened by the table's built-in limit. */
function tableCutoff(t: PurgeTable, days: number, now: Date): Date {
  const applied = withBuiltinLimit(days, t.builtinLimit);
  return new Date(now.getTime() - (applied === 'forever' ? days : applied) * DAY_MS);
}

/** `x.<time> < $1 AND <extra>`: eligible by age, before review-queue protection. */
const aged = (t: PurgeTable) =>
  `x.${t.timeColumn} < $1${t.extraWhere ? ` AND (${t.extraWhere})` : ''}`;
const kept = (t: PurgeTable) =>
  [t.protected ? notPendingReview(t) : null, t.deleteOnlyIf ?? null]
    .filter((c) => c !== null)
    .map((c) => `(${c})`)
    .join(' AND ') || 'TRUE';

interface Scope {
  organizationId: string;
  brandId?: string;
}

/** Placeholders from $2 on that restrict to one organization (and brand). */
function scopeWhere(t: PurgeTable, scope: Scope | null): { sql: string; params: string[] } {
  if (scope === null || t.scopeColumn === null) return { sql: 'TRUE', params: [] };
  if (t.scopeColumn === 'brand_id' && scope.brandId !== undefined) {
    return {
      sql: 'x.organization_id = $2 AND x.brand_id = $3',
      params: [scope.organizationId, scope.brandId],
    };
  }
  return { sql: 'x.organization_id = $2', params: [scope.organizationId] };
}

async function countRows(
  pool: pg.Pool,
  t: PurgeTable,
  cutoff: Date,
  where: string,
  scope: Scope | null,
  cap?: number,
): Promise<number> {
  const s = scopeWhere(t, scope);
  const limit = cap === undefined ? '' : ` LIMIT ${Math.trunc(cap)}`;
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${t.table} x
      WHERE ${s.sql} AND ${aged(t)} AND ${where}${limit}) eligible`,
    [cutoff, ...s.params],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Rows the category would delete now, summed over its tables; stops counting past `cap`. */
async function countEligible(
  pool: pg.Pool,
  c: RetentionCategory,
  days: number,
  now: Date,
  cap?: number,
): Promise<number> {
  let total = 0;
  for (const t of PURGE_TABLES[c]) {
    const left = cap === undefined ? undefined : cap - total;
    if (left !== undefined && left <= 0) break;
    total += await countRows(pool, t, tableCutoff(t, days, now), kept(t), null, left);
  }
  return total;
}

async function countSkipped(
  pool: pg.Pool,
  c: RetentionCategory,
  days: number,
  now: Date,
): Promise<number> {
  let total = 0;
  for (const t of PURGE_TABLES[c]) {
    if (!t.protected) continue;
    total += await countRows(pool, t, tableCutoff(t, days, now), `NOT (${kept(t)})`, null);
  }
  return total;
}

/** Organizations that have rows the category would delete now. */
async function affectedOrganizations(
  pool: pg.Pool,
  c: RetentionCategory,
  days: number,
  now: Date,
): Promise<string[]> {
  const orgs = new Set<string>();
  for (const t of PURGE_TABLES[c]) {
    if (t.scopeColumn === null) continue;
    const { rows } = await pool.query<{ organization_id: string }>(
      `SELECT DISTINCT x.organization_id FROM ${t.table} x WHERE ${aged(t)} AND ${kept(t)}`,
      [tableCutoff(t, days, now)],
    );
    for (const r of rows) orgs.add(r.organization_id);
  }
  return [...orgs].sort();
}

async function isConfirmed(pool: pg.Pool, c: RetentionCategory, days: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM retention_confirmation WHERE category = $1 AND days = $2',
    [c, days],
  );
  return rowCount === 1;
}

/** What a run would do now, per category, with exact counts. Deletes nothing. */
export async function previewPurge(
  pool: pg.Pool,
  s: RetentionSettings,
  now: Date = new Date(),
): Promise<Record<RetentionCategory, CategoryPreview>> {
  const days = purgeDays(s);
  const out = {} as Record<RetentionCategory, CategoryPreview>;
  for (const c of RETENTION_CATEGORIES) {
    const d = days[c];
    if (d === 'forever') {
      out[c] = {
        days: d,
        eligible: 0,
        skippedPendingReview: 0,
        confirmed: false,
        wouldHold: false,
      };
      continue;
    }
    const eligible = await countEligible(pool, c, d, now);
    const confirmed = await isConfirmed(pool, c, d);
    out[c] = {
      days: d,
      eligible,
      skippedPendingReview: await countSkipped(pool, c, d, now),
      confirmed,
      wouldHold: eligible > s.confirmAbove && !confirmed,
    };
  }
  return out;
}

/**
 * Records that `confirmedBy` accepts a large deletion for the category at its
 * current period. It stays valid until the period changes.
 */
export async function confirmRetention(
  pool: pg.Pool,
  s: RetentionSettings,
  category: RetentionCategory,
  days: number,
  confirmedBy: string,
): Promise<{ eligible: number }> {
  const current = purgeDays(s)[category];
  if (current !== days) throw new RetentionSettingMismatchError(category, current, days);
  const now = new Date();
  const eligible = await countEligible(pool, category, days, now);
  const orgs = await affectedOrganizations(pool, category, days, now);
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO retention_confirmation (category, days, eligible_count, confirmed_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (category, days) DO NOTHING`,
      [category, days, eligible, confirmedBy],
    );
    for (const organizationId of orgs) {
      await recordSystemAudit(tx, {
        organizationId,
        action: 'retention.confirmed',
        subjectType: 'retention_confirmation',
        subjectId: null,
        details: { category, days },
      });
    }
  });
  return { eligible };
}

/** Deletes expired export archives and clears their columns, so the request can age out. */
async function removeExpiredExports(pool: pg.Pool, exportDir: string, now: Date): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM privacy_request WHERE export_expires_at < $1',
    [now],
  );
  let removed = 0;
  for (const { id } of rows) {
    if (!UUID.test(id)) continue;
    await rm(path.join(exportDir, `${id}.zip`), { force: true });
    const r = await pool.query(
      `UPDATE privacy_request SET export_sha256 = NULL, export_bytes = NULL, export_expires_at = NULL
        WHERE id = $1 AND export_expires_at < $2`,
      [id, now],
    );
    removed += r.rowCount ?? 0;
  }
  return removed;
}

interface Run {
  readonly pool: pg.Pool;
  readonly s: RetentionSettings;
  readonly log: Logger;
  readonly runId: string;
  readonly now: Date;
  readonly expired: () => boolean;
  readonly counts: PurgeCounts;
}

/** One batch in its own transaction. Returns the number of rows deleted. */
async function deleteBatch(run: Run, t: PurgeTable, cutoff: Date, scope: Scope | null) {
  const s = scopeWhere(t, scope);
  const limitParam = `$${s.params.length + 2}`;
  return withTransaction(run.pool, (tx) =>
    withRetentionDelete(tx, async () => {
      const picked = await tx.query<{ id: string; connection_id: string; external_id: string }>(
        `SELECT x.id${t.fingerprints ? ', x.connection_id, x.external_id' : ''} FROM ${t.table} x
          WHERE ${s.sql} AND ${aged(t)} AND ${kept(t)}
          ORDER BY x.${t.timeColumn} LIMIT ${limitParam} FOR UPDATE SKIP LOCKED`,
        [cutoff, ...s.params, run.s.batchSize],
      );
      const ids = picked.rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      if (t.detachesReplies) await markRepliesParentRemoved(tx, ids);
      if (t.fingerprints) {
        await tx.query(
          `INSERT INTO erased_comment (connection_id, fingerprint)
           SELECT * FROM unnest($1::uuid[], $2::bytea[]) ON CONFLICT DO NOTHING`,
          [
            picked.rows.map((r) => r.connection_id),
            picked.rows.map((r) => commentFingerprint(r.connection_id, r.external_id)),
          ],
        );
      }
      const deleted = await tx.query(`DELETE FROM ${t.table} WHERE id = ANY($1::uuid[])`, [ids]);
      return deleted.rowCount ?? 0;
    }),
  );
}

/** Purges one table within one scope. Returns false when the deadline stopped it. */
async function purgeTable(
  run: Run,
  c: RetentionCategory,
  t: PurgeTable,
  days: number,
  scope: Scope | null,
): Promise<boolean> {
  const cutoff = tableCutoff(t, days, run.now);
  if (t.protected) {
    run.counts.skippedPendingReview += await countRows(
      run.pool,
      t,
      cutoff,
      `NOT (${kept(t)})`,
      scope,
    );
  }
  for (;;) {
    const deleted = await deleteBatch(run, t, cutoff, scope);
    if (deleted > 0) {
      run.counts.byCategory[c] += deleted;
      if (scope !== null) {
        const org = (run.counts.byOrganization[scope.organizationId] ??= {});
        org[c] = (org[c] ?? 0) + deleted;
      }
      run.log.debug('retention.batch', { runId: run.runId, category: c, table: t.table, deleted });
    }
    if (run.expired()) return false;
    if (deleted < run.s.batchSize) return true;
  }
}

/** Organization by organization, brand by brand, table by table. False when stopped early. */
async function purgeCategory(run: Run, c: RetentionCategory, days: number): Promise<boolean> {
  const tables = PURGE_TABLES[c];
  const orgs = await run.pool.query<{ id: string }>('SELECT id FROM organization ORDER BY id');
  for (const { id: organizationId } of orgs.rows) {
    const brands = await run.pool.query<{ id: string }>(
      'SELECT id FROM brand WHERE organization_id = $1 ORDER BY id',
      [organizationId],
    );
    for (const t of tables) {
      if (t.scopeColumn === null) continue;
      const scopes: Scope[] =
        t.scopeColumn === 'brand_id'
          ? brands.rows.map((b) => ({ organizationId, brandId: b.id }))
          : [{ organizationId }];
      for (const scope of scopes) if (!(await purgeTable(run, c, t, days, scope))) return false;
    }
  }
  for (const t of tables) {
    if (t.scopeColumn !== null) continue;
    if (!(await purgeTable(run, c, t, days, null))) return false;
  }
  return true;
}

/** Holds the category: nothing is deleted, and each affected organization is told why once. */
async function hold(run: Run, c: RetentionCategory, days: number, eligibleAtLeast: number) {
  const orgs = await affectedOrganizations(run.pool, c, days, run.now);
  await withTransaction(run.pool, async (tx) => {
    for (const organizationId of orgs) {
      // Once per category and period: the hold is repeated on every run until confirmed.
      const prior = await tx.query(
        `SELECT 1 FROM audit_event
          WHERE organization_id = $1 AND action = 'retention.held'
            AND details->>'category' = $2 AND details->>'days' = $3 LIMIT 1`,
        [organizationId, c, String(days)],
      );
      if (prior.rowCount === 1) continue;
      await recordSystemAudit(tx, {
        organizationId,
        action: 'retention.held',
        subjectType: 'retention_run',
        subjectId: run.runId,
        details: { runId: run.runId, category: c, days },
      });
    }
  });
  run.log.warn('retention.held', {
    runId: run.runId,
    category: c,
    days,
    eligibleAtLeast,
    confirmAbove: run.s.confirmAbove,
  });
}

async function purgeLocked(
  pool: pg.Pool,
  s: RetentionSettings,
  o: PurgeOptions,
): Promise<PurgeResult> {
  const startedAt = performance.now();
  const deadlineMs = o.deadlineMs ?? s.maxRunMinutes * 60_000;
  const now = (o.now ?? (() => new Date()))();
  const days = purgeDays(s);
  const cutoffs: Partial<Record<RetentionCategory, string>> = {};
  for (const c of RETENTION_CATEGORIES) {
    const d = days[c];
    if (d !== 'forever') cutoffs[c] = new Date(now.getTime() - d * DAY_MS).toISOString();
  }
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO retention_run (status, settings, cutoffs) VALUES ('running', $1::jsonb, $2::jsonb)
     RETURNING id`,
    [JSON.stringify(s), JSON.stringify(cutoffs)],
  );
  const runId = inserted.rows[0]!.id;
  const run: Run = {
    pool,
    s,
    log: o.log,
    runId,
    now,
    expired: () => performance.now() - startedAt >= deadlineMs,
    counts: emptyCounts(),
  };
  const held: RetentionCategory[] = [];
  try {
    await forgetStaleConfirmations(pool, s);
    if (o.exportDir !== undefined) {
      const removed = await removeExpiredExports(pool, o.exportDir, now);
      if (removed > 0) o.log.info('retention.exports_removed', { runId, removed });
    }
    let finished = true;
    for (const c of PURGE_ORDER) {
      const d = days[c];
      if (d === 'forever') continue;
      const eligible = await countEligible(pool, c, d, now, s.confirmAbove + 1);
      if (eligible > s.confirmAbove && !(await isConfirmed(pool, c, d))) {
        held.push(c);
        await hold(run, c, d, eligible);
        continue;
      }
      if (!(await purgeCategory(run, c, d))) {
        finished = false;
        break;
      }
    }

    const purged = Object.entries(run.counts.byOrganization);
    if (purged.length > 0) {
      await withTransaction(pool, async (tx) => {
        for (const [organizationId, byCategory] of purged) {
          const counts: Record<string, number> = {};
          for (const [c, n] of Object.entries(byCategory)) if (n > 0) counts[c] = n;
          await recordSystemAudit(tx, {
            organizationId,
            action: 'retention.purged',
            subjectType: 'retention_run',
            subjectId: runId,
            details: { runId, counts },
          });
        }
      });
    }

    const status = finished ? 'done' : 'partial';
    await pool.query(
      `UPDATE retention_run SET status = $2, counts = $3::jsonb, held = $4::text[],
              skipped_pending_review = $5, finished_at = now()
        WHERE id = $1`,
      [runId, status, JSON.stringify(run.counts.byCategory), held, run.counts.skippedPendingReview],
    );
    await publishRetentionStatus(pool, s);
    o.log.info('retention.purge_done', {
      runId,
      status,
      ...run.counts.byCategory,
      held: held.join(','),
      skippedPendingReview: run.counts.skippedPendingReview,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { runId, status, held, counts: run.counts };
  } catch (err) {
    await pool
      .query(
        `UPDATE retention_run SET status = 'failed', counts = $2::jsonb, held = $3::text[],
                skipped_pending_review = $4, finished_at = now()
          WHERE id = $1`,
        [runId, JSON.stringify(run.counts.byCategory), held, run.counts.skippedPendingReview],
      )
      .catch(() => undefined);
    throw err;
  }
}

/**
 * One purge run: deletes, in batches of their own transaction, the rows past each
 * category's period. Only one run at a time across the instance; another caller
 * gets `skipped_locked`. A run stopped by its deadline is `partial`, and the next
 * run carries on, since cutoffs are recomputed and deleted rows are simply gone.
 */
export async function runPurge(
  pool: pg.Pool,
  s: RetentionSettings,
  o: PurgeOptions,
): Promise<PurgeResult> {
  const locked = await withPurgeLock(pool, () => purgeLocked(pool, s, o));
  if (locked.acquired) return locked.value;
  o.log.info('retention.skipped_locked');
  return { runId: null, status: 'skipped_locked', held: [], counts: emptyCounts() };
}
