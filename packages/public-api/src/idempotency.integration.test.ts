import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import {
  IdempotencyError,
  PgIdempotency,
  purgeExpiredIdempotency,
  requestFingerprint,
  stripSecrets,
  type StoredResponse,
} from './idempotency.js';
import { PgApiKeys, type ApiKeyContext } from './keys/store.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let idem: PgIdempotency;
let keys: PgApiKeys;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = new pg.Pool({ connectionString: h.db.url.href, max: 8 });
  idem = new PgIdempotency(pool);
  keys = new PgApiKeys(pool);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

async function ctxOf(orgId?: string, userId?: string): Promise<ApiKeyContext> {
  const t =
    orgId && userId ? { organizationId: orgId, userId } : await seedTenant(h.c, `i${++seq}`);
  const { key } = await keys.create(t.organizationId, t.userId, {
    name: `k${++seq}`,
    scope: 'write',
  });
  return { organizationId: t.organizationId, apiKeyId: key.id, scope: 'write' };
}

const fp = (s: string) => requestFingerprint('hideComment', { id: s }, {});
const ok = (n: number): StoredResponse => ({ status: 202, body: { n } });
const rows = (ctx: ApiKeyContext) =>
  pool
    .query('SELECT * FROM api_idempotency_record WHERE api_key_id = $1', [ctx.apiKeyId])
    .then((r) => r.rows);

describe('PgIdempotency.run', () => {
  it('runs fn directly without a key and stores nothing', async () => {
    const ctx = await ctxOf();
    const fn = vi.fn(() => Promise.resolve(ok(1)));
    expect(await idem.run(ctx, undefined, fp('a'), fn)).toEqual({ ...ok(1), replayed: false });
    expect(await rows(ctx)).toHaveLength(0);
  });

  it('replays the stored response for the same key and fingerprint without calling fn again', async () => {
    const ctx = await ctxOf();
    const fn = vi.fn(() => Promise.resolve(ok(1)));
    const first = await idem.run(ctx, 'k-1', fp('a'), fn);
    const second = await idem.run(ctx, 'k-1', fp('a'), fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await rows(ctx)).toMatchObject([{ state: 'completed', response_status: 202 }]);
  });

  it('rejects the same key with a different fingerprint as 422 idempotency_key_reused', async () => {
    const ctx = await ctxOf();
    await idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve(ok(1)));
    const fn = vi.fn(() => Promise.resolve(ok(2)));
    await expect(idem.run(ctx, 'k-1', fp('b'), fn)).rejects.toMatchObject({
      status: 422,
      code: 'idempotency_key_reused',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('answers 409 while the first call is still running, then replays once it finishes', async () => {
    const ctx = await ctxOf();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = vi.fn();
    const first = idem.run(ctx, 'k-1', fp('a'), async () => {
      started();
      await gate;
      return ok(1);
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    const second = idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve(ok(2)));
    await expect(second).rejects.toBeInstanceOf(IdempotencyError);
    await expect(second).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_request_in_progress',
    });
    release();
    await first;
    expect(await idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve(ok(3)))).toEqual({
      ...ok(1),
      replayed: true,
    });
  });

  it('still reports a fingerprint mismatch (422) while the first call is running', async () => {
    const ctx = await ctxOf();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = idem.run(ctx, 'k-1', fp('a'), async () => {
      await gate;
      return ok(1);
    });
    await vi.waitFor(async () => expect(await rows(ctx)).toHaveLength(1));
    await expect(idem.run(ctx, 'k-1', fp('b'), () => Promise.resolve(ok(2)))).rejects.toMatchObject(
      { status: 422 },
    );
    release();
    await first;
  });

  it('takes over a record that has been in progress for more than 60 s', async () => {
    const ctx = await ctxOf();
    await pool.query(
      `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256,
                                           state, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'k-1', $3, 'in_progress', now() + interval '1 day',
               now() - interval '61 seconds', now() - interval '61 seconds')`,
      [ctx.organizationId, ctx.apiKeyId, fp('a')],
    );
    const fn = vi.fn(() => Promise.resolve(ok(7)));
    expect(await idem.run(ctx, 'k-1', fp('a'), fn)).toEqual({ ...ok(7), replayed: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await rows(ctx)).toMatchObject([{ state: 'completed' }]);
  });

  it('does not take over a record that has been in progress for 59 s', async () => {
    const ctx = await ctxOf();
    await pool.query(
      `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256,
                                           state, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'k-1', $3, 'in_progress', now() + interval '1 day',
               now() - interval '59 seconds', now() - interval '59 seconds')`,
      [ctx.organizationId, ctx.apiKeyId, fp('a')],
    );
    const fn = vi.fn(() => Promise.resolve(ok(7)));
    await expect(idem.run(ctx, 'k-1', fp('a'), fn)).rejects.toMatchObject({ status: 409 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent takeovers run', async () => {
    const ctx = await ctxOf();
    await pool.query(
      `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256,
                                           state, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'k-1', $3, 'in_progress', now() + interval '1 day',
               now() - interval '90 seconds', now() - interval '90 seconds')`,
      [ctx.organizationId, ctx.apiKeyId, fp('a')],
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = vi.fn(async () => {
      await gate;
      return ok(1);
    });
    const results = Promise.allSettled([
      idem.run(ctx, 'k-1', fp('a'), fn),
      idem.run(ctx, 'k-1', fp('a'), fn),
    ]);
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    release();
    const settled = await results;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('deletes the record when fn throws a 5xx or an unknown error, so a retry runs fn again', async () => {
    const ctx = await ctxOf();
    const boom = Object.assign(new Error('boom'), { status: 500 });
    await expect(idem.run(ctx, 'k-1', fp('a'), () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await rows(ctx)).toHaveLength(0);
    const fn = vi.fn(() => Promise.resolve(ok(2)));
    expect(await idem.run(ctx, 'k-1', fp('a'), fn)).toEqual({ ...ok(2), replayed: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stores a 4xx response like any other and replays it', async () => {
    const ctx = await ctxOf();
    const notFound: StoredResponse = {
      status: 404,
      body: { error: { code: 'not_found', message: 'Not found.' } },
    };
    const fn = vi.fn(() => Promise.resolve(notFound));
    await idem.run(ctx, 'k-1', fp('a'), fn);
    expect(await idem.run(ctx, 'k-1', fp('a'), fn)).toEqual({ ...notFound, replayed: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never stores secrets or tokens from the response body', async () => {
    const ctx = await ctxOf();
    const body = { a: { secret: 'whsec_x', token: 'fbk_y', b: 1 } };
    await idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve({ status: 201, body }));
    const [row] = await rows(ctx);
    expect(row.response_body).toEqual({ a: { b: 1 } });
    expect(JSON.stringify(row)).not.toMatch(/whsec_x|fbk_y/);
  });

  it('runs the same key from two API keys of one organization as two independent requests', async () => {
    const t = await seedTenant(h.c, `i${++seq}`);
    const a = await ctxOf(t.organizationId, t.userId);
    const b = await ctxOf(t.organizationId, t.userId);
    const fn = vi.fn(() => Promise.resolve(ok(1)));
    const ra = await idem.run(a, 'shared', fp('a'), fn);
    const rb = await idem.run(b, 'shared', fp('a'), fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect([ra.replayed, rb.replayed]).toEqual([false, false]);
    expect(await rows(a)).toHaveLength(1);
    expect(await rows(b)).toHaveLength(1);
  });

  it('treats an expired record as absent', async () => {
    const ctx = await ctxOf();
    await idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve(ok(1)));
    await pool.query(
      `UPDATE api_idempotency_record SET expires_at = now() - interval '1 second' WHERE api_key_id = $1`,
      [ctx.apiKeyId],
    );
    const fn = vi.fn(() => Promise.resolve(ok(2)));
    expect(await idem.run(ctx, 'k-1', fp('zzz'), fn)).toEqual({ ...ok(2), replayed: false });
    expect(await rows(ctx)).toHaveLength(1);
  });

  it('sets a 24 h expiry', async () => {
    const ctx = await ctxOf();
    await idem.run(ctx, 'k-1', fp('a'), () => Promise.resolve(ok(1)));
    const { rows: r } = await pool.query(
      `SELECT extract(epoch FROM expires_at - now()) AS s FROM api_idempotency_record WHERE api_key_id = $1`,
      [ctx.apiKeyId],
    );
    expect(Number(r[0].s)).toBeGreaterThan(86_300);
    expect(Number(r[0].s)).toBeLessThanOrEqual(86_400);
  });
});

describe('purgeExpiredIdempotency', () => {
  it('deletes only expired records, in batches', async () => {
    const ctx = await ctxOf();
    for (const k of ['a', 'b', 'c']) await idem.run(ctx, k, fp(k), () => Promise.resolve(ok(1)));
    await pool.query(
      `UPDATE api_idempotency_record SET expires_at = now() - interval '1 hour'
        WHERE api_key_id = $1 AND idempotency_key IN ('a', 'b')`,
      [ctx.apiKeyId],
    );
    expect(await purgeExpiredIdempotency(pool, 1)).toBe(2);
    expect((await rows(ctx)).map((r) => r.idempotency_key)).toEqual(['c']);
  });
});

describe('requestFingerprint', () => {
  it('is stable across key order and differs by route, params and body', () => {
    const base = requestFingerprint('r', { a: '1', b: '2' }, { x: 1, y: { p: 1, q: 2 } });
    expect(base).toHaveLength(32);
    expect(requestFingerprint('r', { b: '2', a: '1' }, { y: { q: 2, p: 1 }, x: 1 })).toEqual(base);
    expect(requestFingerprint('s', { a: '1', b: '2' }, { x: 1, y: { p: 1, q: 2 } })).not.toEqual(
      base,
    );
    expect(requestFingerprint('r', { a: '1', b: '3' }, { x: 1, y: { p: 1, q: 2 } })).not.toEqual(
      base,
    );
    expect(requestFingerprint('r', { a: '1', b: '2' }, { x: 2, y: { p: 1, q: 2 } })).not.toEqual(
      base,
    );
  });

  it('does not let a param value shift into the route id or another param', () => {
    expect(requestFingerprint('ab', { c: 'd' }, {})).not.toEqual(
      requestFingerprint('a', { bc: 'd' }, {}),
    );
  });
});

describe('stripSecrets', () => {
  it('removes secret and token properties at any depth, including inside arrays', () => {
    expect(stripSecrets({ a: { secret: 'x', token: 'y', b: 1 } })).toEqual({ a: { b: 1 } });
    expect(stripSecrets([{ token: 't', k: [{ secret: 's', n: null }] }, 'str', 3])).toEqual([
      { k: [{ n: null }] },
      'str',
      3,
    ]);
    expect(stripSecrets('plain')).toBe('plain');
  });
});
