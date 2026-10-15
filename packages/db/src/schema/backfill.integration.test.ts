import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant } from '../testing/index.js';

let pool: pg.Client;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ c: pool, close } = await migratedDb());
});
afterAll(() => close());
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; constraint?: string }) => e.constraint ?? e.code,
  );

describe('connection_backfill and comment.ingest_origin', () => {
  it('one row per connection, cascades with the connection, tenant FK enforced', async () => {
    const t = await seedTenant(pool, 'bf1');
    const ins = (org = t.organizationId) =>
      pool.query(
        `INSERT INTO connection_backfill (connection_id, organization_id, brand_id, run_id, status, window_start, window_end)
         VALUES ($1, $2, $3, gen_random_uuid(), 'pending', now() - interval '30 days', now())`,
        [t.connectionId, org, t.brandId],
      );
    await ins();
    expect(await code(ins())).toBe('connection_backfill_pkey');
    const other = await seedTenant(pool, 'bf1-other');
    await pool.query(`DELETE FROM connection_backfill WHERE connection_id = $1`, [t.connectionId]);
    expect(await code(ins(other.organizationId))).toBe('connection_backfill_connection_fkey');
    await ins();
    await pool.query(`DELETE FROM connection WHERE id = $1`, [t.connectionId]);
    const left = await pool.query(`SELECT 1 FROM connection_backfill WHERE connection_id = $1`, [
      t.connectionId,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('checks status, reason, counts, queue, cursor and window', async () => {
    const t = await seedTenant(pool, 'bf2');
    const bad = (col: string, val: string) =>
      pool.query(
        `INSERT INTO connection_backfill (connection_id, organization_id, brand_id, run_id, status, window_start, window_end, ${col})
         VALUES ($1, $2, $3, gen_random_uuid(), 'pending', now() - interval '1 day', now(), ${val})`,
        [t.connectionId, t.organizationId, t.brandId],
      );
    expect(await code(bad('failure_reason', `'Bad Reason'`))).toBe(
      'connection_backfill_failure_reason_check',
    );
    expect(await code(bad('imported_count', '-1'))).toBe('connection_backfill_counts_check');
    expect(await code(bad('source_queue', `ARRAY['../x']`))).toBe(
      'connection_backfill_source_queue_check',
    );
    expect(await code(bad('comment_cursor', `repeat('x', 2049)`))).toBe(
      'connection_backfill_comment_cursor_check',
    );
    expect(await code(bad('skipped_sources', `'{}'::jsonb`))).toBe(
      'connection_backfill_skipped_sources_check',
    );
    const raw = (status: string, start: string, end: string) =>
      pool.query(
        `INSERT INTO connection_backfill (connection_id, organization_id, brand_id, run_id, status, window_start, window_end)
         VALUES ($1, $2, $3, gen_random_uuid(), '${status}', ${start}, ${end})`,
        [t.connectionId, t.organizationId, t.brandId],
      );
    expect(await code(raw('done', 'now()', 'now()'))).toBe('connection_backfill_status_check');
    expect(await code(raw('pending', 'now()', `now() - interval '1 day'`))).toBe(
      'connection_backfill_window_check',
    );
  });

  it('comment.ingest_origin defaults to live and only accepts live|backfill', async () => {
    const r = await pool.query(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'comment' AND column_name = 'ingest_origin'`,
    );
    expect(r.rows[0]).toMatchObject({ column_default: "'live'::text", is_nullable: 'NO' });
    const c = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'comment_ingest_origin_check'`,
    );
    expect(c.rows[0].def).toContain("'backfill'");
  });
});
