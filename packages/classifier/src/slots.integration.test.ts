import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, uuid } from '@feedbouncer/db/testing';
import { BrandSlots } from './slots.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
const brandA = uuid();
const brandB = uuid();

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'slots-test', onIdleError: () => {}, max: 10 });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

describe('BrandSlots', () => {
  it('namespaces are independent: a full classify namespace does not block policy slots', async () => {
    const clf = new BrandSlots(pool, 1);
    const pol = new BrandSlots(pool, 1, 'fb.policy');
    const a = await clf.acquire(brandA);
    expect(a).not.toBeNull();
    expect(await clf.acquire(brandA)).toBeNull();
    const b = await pol.acquire(brandA);
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('rejects an invalid namespace', () => {
    expect(() => new BrandSlots(pool, 1, 'Bad Name')).toThrow(RangeError);
  });

  it('rejects an invalid perBrand', () => {
    expect(() => new BrandSlots(pool, 0)).toThrow(RangeError);
    expect(() => new BrandSlots(pool, 65)).toThrow(RangeError);
    expect(() => new BrandSlots(pool, 1.5)).toThrow(RangeError);
  });

  it('grants up to perBrand concurrent leases per brand, independently per brand, and frees on release', async () => {
    const slots = new BrandSlots(pool, 2);
    const a1 = await slots.acquire(brandA);
    const a2 = await slots.acquire(brandA);
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(await slots.acquire(brandA)).toBeNull();
    const b1 = await slots.acquire(brandB);
    expect(b1).not.toBeNull();
    await a1!.release();
    await a1!.release(); // idempotent
    const a3 = await slots.acquire(brandA);
    expect(a3).not.toBeNull();
    await Promise.all([a2!.release(), a3!.release(), b1!.release()]);
  });

  it('a crashed holder (connection closed) frees its slot', async () => {
    const slots = new BrandSlots(pool, 1);
    const l = await slots.acquire(brandA);
    expect(l).not.toBeNull();
    expect(await slots.acquire(brandA)).toBeNull();
    await l!.destroy();
    const again = await slots.acquire(brandA);
    expect(again).not.toBeNull();
    await again!.release();
  });
});
