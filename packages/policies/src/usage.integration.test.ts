import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { PgPolicyUsage } from './usage.js';

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let usage: PgPolicyUsage;
let a: { organizationId: string; brandId: string };

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, {
    applicationName: 'policies-usage-test',
    onIdleError: () => {},
    max: 10,
  });
  usage = new PgPolicyUsage(pool, { now: () => Date.parse('2026-10-15T12:00:00Z') });
  const t = await seedTenant(db.c, 'usage');
  a = { organizationId: t.organizationId, brandId: t.brandId };
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

describe('PgPolicyUsage', () => {
  it('consumes until the limit, then refuses', async () => {
    expect(await usage.consume(a, 2)).toBe(true);
    expect(await usage.consume(a, 2)).toBe(true);
    expect(await usage.consume(a, 2)).toBe(false);
    expect(await usage.current(a, 2)).toMatchObject({
      used: 2,
      limit: 2,
      resetsAt: new Date('2026-11-01T00:00:00.000Z'),
    });
  });

  it('concurrent consumers never exceed the limit (the last unit goes to exactly one)', async () => {
    const b = await seedTenant(db.c, 'usage-race');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    const r = await Promise.all(Array.from({ length: 8 }, () => usage.consume(bs, 3)));
    expect(r.filter(Boolean)).toHaveLength(3);
    expect((await usage.current(bs, 3)).used).toBe(3);
  });

  it('with one call left, exactly one of two racing consumers wins', async () => {
    const b = await seedTenant(db.c, 'usage-last');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    expect(await usage.consume(bs, 2)).toBe(true);
    const r = await Promise.all([usage.consume(bs, 2), usage.consume(bs, 2)]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect((await usage.current(bs, 2)).used).toBe(2);
  });

  it('a new month starts at zero', async () => {
    const next = new PgPolicyUsage(pool, { now: () => Date.parse('2026-11-02T00:00:00Z') });
    expect(await usage.consume(a, 2)).toBe(false);
    expect(await next.current(a, 2)).toEqual({
      used: 0,
      limit: 2,
      resetsAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(await next.consume(a, 2)).toBe(true);
    expect((await next.current(a, 2)).used).toBe(1);
    expect((await usage.current(a, 2)).used).toBe(2);
  });

  it('limit 0 refuses everything', async () => {
    const b = await seedTenant(db.c, 'usage-zero');
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    expect(await usage.consume(bs, 0)).toBe(false);
    expect((await usage.current(bs, 0)).used).toBe(0);
  });

  it('a forged organization cannot consume or read another brand budget', async () => {
    const b = await seedTenant(db.c, 'usage-forged');
    const forged = { organizationId: a.organizationId, brandId: b.brandId };
    expect(await usage.consume(forged, 5)).toBe(false);
    const bs = { organizationId: b.organizationId, brandId: b.brandId };
    expect(await usage.consume(bs, 5)).toBe(true);
    expect(await usage.consume(forged, 5)).toBe(false);
    expect((await usage.current(forged, 5)).used).toBe(0);
    expect((await usage.current(bs, 5)).used).toBe(1);
  });
});
