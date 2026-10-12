import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgSyncRecorder } from './index.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let connectionId: string;
let otherId: string;
let orgId: string;
let brandId: string;

const row = async (id: string) =>
  (await pool.query('SELECT * FROM connection_sync WHERE connection_id = $1', [id])).rows[0];

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'connectors-sync-test', onIdleError: () => {} });
  const t = await seedTenant(h.c, 'sync-a');
  connectionId = t.connectionId;
  orgId = t.organizationId;
  brandId = t.brandId;
  otherId = (await seedTenant(h.c, 'sync-b')).connectionId;
});
afterAll(async () => {
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM connection_sync');
});

describe('PgSyncRecorder', () => {
  it('records success and failure, resets the streak, and coalesces successes', async () => {
    let t = 0;
    const rec = new PgSyncRecorder(pool, { coalesceMs: 10_000, now: () => t });
    await rec.failure(connectionId, { code: 'upstream_5xx', errorClass: 'retryable' });
    await rec.failure(connectionId, { code: 'upstream_5xx', errorClass: 'retryable' });
    let r = await row(connectionId);
    expect(r).toMatchObject({
      consecutive_failures: 2,
      last_error_code: 'upstream_5xx',
      last_error_class: 'retryable',
      last_success_at: null,
      organization_id: orgId,
      brand_id: brandId,
    });
    await rec.success(connectionId, 'read');
    r = await row(connectionId);
    expect(r.consecutive_failures).toBe(0);
    expect(r.last_error_code).toBe('upstream_5xx'); // last error is kept for display
    const first = r.last_success_at;
    expect(first).not.toBeNull();
    t = 5_000;
    await rec.success(connectionId, 'read');
    expect((await row(connectionId)).last_success_at).toEqual(first);
    t = 20_000;
    await new Promise((res) => setTimeout(res, 5));
    await rec.success(connectionId, 'read');
    expect((await row(connectionId)).last_success_at.getTime()).toBeGreaterThan(first.getTime());
  });

  it('a failure re-opens the coalescing window', async () => {
    let t = 0;
    const rec = new PgSyncRecorder(pool, { coalesceMs: 10_000, now: () => t });
    await rec.success(connectionId, 'read');
    t = 1_000;
    await rec.failure(connectionId, { code: 'timeout', errorClass: 'retryable' });
    t = 2_000;
    await rec.success(connectionId, 'read');
    expect((await row(connectionId)).consecutive_failures).toBe(0);
  });

  it('ignores unknown or non-uuid connection ids', async () => {
    const rec = new PgSyncRecorder(pool);
    const ghost = '00000000-0000-4000-8000-000000000000';
    await expect(rec.success('not-a-uuid', 'webhook')).resolves.toBeUndefined();
    await expect(rec.success(ghost, 'webhook')).resolves.toBeUndefined();
    await expect(
      rec.failure(ghost, { code: 'timeout', errorClass: 'retryable' }),
    ).resolves.toBeUndefined();
    expect(
      (await pool.query('SELECT 1 FROM connection_sync WHERE connection_id = $1', [ghost]))
        .rowCount,
    ).toBe(0);
  });

  it('replaces invalid error codes with unspecified', async () => {
    await new PgSyncRecorder(pool).failure(connectionId, {
      code: 'Bad Code!',
      errorClass: 'non_retryable',
    });
    expect((await row(connectionId)).last_error_code).toBe('unspecified');
  });

  it('keeps state per connection', async () => {
    const rec = new PgSyncRecorder(pool);
    await rec.failure(connectionId, { code: 'timeout', errorClass: 'retryable' });
    await rec.success(otherId, 'webhook');
    expect((await row(otherId)).consecutive_failures).toBe(0);
    expect((await row(connectionId)).consecutive_failures).toBe(1);
  });
});
