import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb } from '@feedbouncer/db/testing';
import { effectiveDays, loadRetentionSettings, retentionWarnings } from './settings.js';
import { publishRetentionStatus, readOrgRetentionStatus, readRetentionStatus } from './status.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'privacy-status-test', onIdleError: () => {} });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
});

describe('retention status', () => {
  it('round-trips settings, effective values and warnings', async () => {
    const settings = loadRetentionSettings({
      RETENTION_COMMENTS_DAYS: '30',
      RETENTION_PREVIEWS_DAYS: '20',
      RETENTION_AUDIT_DAYS: '90',
    });
    await publishRetentionStatus(pool, settings);
    const status = await readRetentionStatus(pool);
    expect(status.settings).toEqual(settings);
    expect(status.effective).toEqual(effectiveDays(settings));
    expect(status.warnings).toEqual(retentionWarnings(settings));
    expect(status.warnings).toEqual(
      expect.arrayContaining(['audit_below_recommended', 'decisions_capped_by_comments']),
    );
    expect(status.updatedAt).toBeInstanceOf(Date);
    expect(status.lastRun).toBeNull();
  });

  it('keeps a single row when published twice and shows the newest settings', async () => {
    await publishRetentionStatus(pool, loadRetentionSettings({}));
    const settings = loadRetentionSettings({ RETENTION_COMMENTS_DAYS: '7' });
    await publishRetentionStatus(pool, settings);
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM retention_status');
    expect(rows[0]!.n).toBe('1');
    expect((await readRetentionStatus(pool)).settings).toEqual(settings);
  });

  it('reports the most recent finished run', async () => {
    await ctx.c.query(
      `INSERT INTO retention_run (status, counts, held, skipped_pending_review, finished_at)
       VALUES ('done', '{"comments":4}', '{audit}', 2, now() - interval '1 hour'),
              ('partial', '{"comments":9}', '{}', 0, now()),
              ('running', '{}', '{}', 0, NULL)`,
    );
    const { lastRun } = await readRetentionStatus(pool);
    expect(lastRun).toMatchObject({
      status: 'partial',
      counts: { comments: 9 },
      held: [],
      skippedPendingReview: 0,
    });
    expect(lastRun?.finishedAt).toBeInstanceOf(Date);
  });

  it("lists only the organization's holds that still apply", async () => {
    const { rows } = await ctx.c.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('held-org') RETURNING id",
    );
    const org = rows[0]!.id;
    const hold = (category: string, days: number) =>
      ctx.c.query(
        `INSERT INTO audit_event (organization_id, actor_type, action, subject_type, details)
         VALUES ($1, 'system', 'retention.held', 'retention_run', $2::jsonb)`,
        [org, JSON.stringify({ category, days })],
      );
    await publishRetentionStatus(
      pool,
      loadRetentionSettings({ RETENTION_COMMENTS_DAYS: '30', RETENTION_AUDIT_DAYS: '400' }),
    );
    await hold('comments', 30);
    await hold('audit', 400);
    await hold('previews', 3);
    await ctx.c.query(
      "INSERT INTO retention_confirmation (category, days, eligible_count, confirmed_by) VALUES ('audit', 400, 5, 'ops')",
    );

    const status = await readOrgRetentionStatus(pool, org);
    expect(status.held.map((h) => [h.category, h.days])).toEqual([['comments', 30]]);
  });
});
