import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { DEFAULT_THRESHOLDS } from './defaults.js';
import { PgThresholdStore } from './thresholds-store.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgThresholdStore;
let A: Tenant;
let B: Tenant;
const scope = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'thresholds-test', onIdleError: () => {} });
  store = new PgThresholdStore(pool);
  A = await seedTenant(ctx.c, 'tha');
  B = await seedTenant(ctx.c, 'thb');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('PgThresholdStore', () => {
  it('policy() returns defaults for a brand with no rows', async () => {
    expect(await store.policy(scope(A))).toEqual(DEFAULT_THRESHOLDS);
  });

  it('apply() upserts, records who and when, returns before/after, and only real changes', async () => {
    const ch = await inTx((c) =>
      store.apply(
        c,
        scope(A),
        [
          { category: 'spam', threshold: 0.6, action: 'hide' },
          { category: 'profanity', threshold: 0.8, action: 'flag' },
        ],
        A.userId,
      ),
    );
    expect(ch).toEqual([
      { category: 'spam', before: null, after: { threshold: 0.6, action: 'hide' } },
      { category: 'profanity', before: null, after: { threshold: 0.8, action: 'flag' } },
    ]);
    const list = await store.list(scope(A));
    expect(list.find((v) => v.category === 'spam')).toMatchObject({
      threshold: 0.6,
      action: 'hide',
      source: 'brand',
      updatedByUserId: A.userId,
    });
    expect(list.find((v) => v.category === 'spam')?.updatedAt).toBeInstanceOf(Date);
    expect(list.find((v) => v.category === 'hate_speech')).toMatchObject({
      threshold: 0.8,
      action: 'hide',
      source: 'default',
      updatedAt: null,
      updatedByUserId: null,
    });
    expect(list).toHaveLength(7);
  });

  it('apply() with an identical value reports no change; useDefault deletes the override', async () => {
    await inTx(async (c) => {
      expect(
        await store.apply(
          c,
          scope(A),
          [{ category: 'spam', threshold: 0.6, action: 'hide' }],
          A.userId,
        ),
      ).toEqual([]);
      expect(
        await store.apply(c, scope(A), [{ category: 'spam', useDefault: true }], A.userId),
      ).toEqual([{ category: 'spam', before: { threshold: 0.6, action: 'hide' }, after: null }]);
      expect(
        await store.apply(c, scope(A), [{ category: 'spam', useDefault: true }], A.userId),
      ).toEqual([]);
    });
    expect((await store.policy(scope(A))).spam.source).toBe('default');
    const n = await ctx.c.query(
      "SELECT count(*)::int AS n FROM classifier_threshold WHERE brand_id = $1 AND category = 'spam'",
      [A.brandId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('a changed value updates in place and is reported with the previous value', async () => {
    const ch = await inTx((c) =>
      store.apply(
        c,
        scope(A),
        [{ category: 'profanity', threshold: 0.5, action: 'hide' }],
        A.userId,
      ),
    );
    expect(ch).toEqual([
      {
        category: 'profanity',
        before: { threshold: 0.8, action: 'flag' },
        after: { threshold: 0.5, action: 'hide' },
      },
    ]);
    expect((await store.policy(scope(A))).profanity).toMatchObject({
      threshold: 0.5,
      action: 'hide',
      source: 'brand',
    });
  });

  it("another brand's overrides are invisible and cannot be written through a foreign scope", async () => {
    expect(await store.policy(scope(B))).toEqual(DEFAULT_THRESHOLDS);
    await expect(
      inTx((c) =>
        store.apply(
          c,
          { organizationId: B.organizationId, brandId: A.brandId },
          [{ category: 'spam', threshold: 0.1, action: 'flag' }],
          B.userId,
        ),
      ),
    ).rejects.toThrow();
    expect((await store.policy(scope(A))).spam.source).toBe('default');
  });

  it('a rolled back transaction leaves nothing behind', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await store.apply(
        c,
        scope(B),
        [{ category: 'spam', threshold: 0.3, action: 'flag' }],
        B.userId,
      );
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await store.policy(scope(B))).toEqual(DEFAULT_THRESHOLDS);
  });
});
