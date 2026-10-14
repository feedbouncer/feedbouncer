import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { EnqueueRequest, EnqueueResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgCommentStore } from './store.js';
import { PgAdTracking, type DiscoveredAdRow } from './ads/tracking.js';
import { PollScheduler, type SchedulerSettings } from './scheduler.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let tracking: PgAdTracking;
let a: Tenant;
let b: Tenant;
let fbA: ConnectionScope;
let igA: ConnectionScope;
let adsA: ConnectionScope;
let adsB: ConnectionScope;
let fbB: ConnectionScope;

let nowMs: number;
let seen: Set<string>;
let enqueued: EnqueueRequest[];
let failFirst: boolean;
const warnings: string[] = [];

const settings: SchedulerSettings = {
  tickSec: 30,
  discoveryIntervalSec: 900,
  pollIntervalSec: 300,
  graceDays: 7,
  maxConnectionsPerTick: 100,
};

const producer = {
  enqueue: async (req: EnqueueRequest): Promise<EnqueueResult> => {
    if (failFirst) {
      failFirst = false;
      throw new Error('redis down');
    }
    const key = `${req.type}:${req.scope.connectionId}:${JSON.stringify(req.payload)}`;
    const duplicate = seen.has(key);
    seen.add(key);
    if (!duplicate) enqueued.push(req);
    return duplicate
      ? { status: 'deduplicated', ledgerId: key, jobId: key, state: 'queued' }
      : { status: 'enqueued', ledgerId: key, jobId: key };
  },
};
const scheduler = (override: Partial<SchedulerSettings> = {}) =>
  new PollScheduler({
    pool,
    producer,
    tracking,
    clock: { now: () => nowMs },
    log: { warn: (m) => void warnings.push(m) },
    settings: { ...settings, ...override },
  });
const ofType = (type: string) => enqueued.filter((e) => e.type === type);

const connect = async (x: Tenant, platform: string, ext: string): Promise<ConnectionScope> => {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [x.organizationId, x.brandId, platform, ext],
  );
  return { organizationId: x.organizationId, brandId: x.brandId, connectionId: r.rows[0]!.id };
};
const setStatus = (s: ConnectionScope, status: string) =>
  pool.query(
    'UPDATE connection SET status = $4 WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
    [s.organizationId, s.brandId, s.connectionId, status],
  );

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'scheduler-test', onIdleError: () => {} });
  tracking = new PgAdTracking(pool, new PgCommentStore(pool));
  a = await seedTenant(ctx.c, 'sched-a');
  b = await seedTenant(ctx.c, 'sched-b');
  await ctx.c.query('DELETE FROM connection WHERE id = ANY($1::uuid[])', [
    [a.connectionId, b.connectionId],
  ]);
  fbA = await connect(a, 'facebook', '900');
  igA = await connect(a, 'instagram', '17841400000000001');
  adsA = await connect(a, 'meta_ads', '1001');
  fbB = await connect(b, 'facebook', '901');
  adsB = await connect(b, 'meta_ads', '1002');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 14, 12, 0, 0);
  seen = new Set();
  enqueued = [];
  failFirst = false;
  warnings.length = 0;
  for (const x of [a, b]) {
    await ctx.c.query('DELETE FROM source WHERE organization_id = $1 AND brand_id = $2', [
      x.organizationId,
      x.brandId,
    ]);
    await ctx.c.query('DELETE FROM meta_ad WHERE organization_id = $1 AND brand_id = $2', [
      x.organizationId,
      x.brandId,
    ]);
    await ctx.c.query(
      `UPDATE connection SET status = 'active' WHERE organization_id = $1 AND brand_id = $2`,
      [x.organizationId, x.brandId],
    );
  }
});

const recordAdOnBoth = () => {
  const row: DiscoveredAdRow = {
    externalId: '5001',
    adAccountExternalId: '1001',
    effectiveStatus: 'ACTIVE',
    active: true,
    facebook: { sourceExternalId: '900_1', resolution: 'linked', connection: fbA },
    instagram: {
      sourceExternalId: '17900000000000001',
      accountExternalId: '17841400000000001',
      resolution: 'linked',
      connection: igA,
    },
  };
  return tracking.recordAds(adsA, [row], new Date(nowMs));
};

describe('PollScheduler', () => {
  it('enqueues one discovery per active meta_ads connection per bucket, deduplicated across ticks and replicas', async () => {
    const s1 = scheduler();
    const s2 = scheduler();
    expect(await s1.tick()).toMatchObject({ discovery: 2, deduplicated: 0 });
    expect(await s2.tick()).toMatchObject({ discovery: 0, deduplicated: 2 });
    await s1.tick();
    expect(ofType('ad_discovery')).toHaveLength(2);
    nowMs += settings.discoveryIntervalSec * 1000;
    await s1.tick();
    expect(ofType('ad_discovery')).toHaveLength(4);
    expect(ofType('ad_discovery').every((e) => e.platform === 'meta_ads')).toBe(true);
  });

  it("rotates through ads connections beyond one tick's limit", async () => {
    const s = scheduler({ maxConnectionsPerTick: 1 });
    await s.tick();
    await s.tick();
    const ids = ofType('ad_discovery').map((e) => e.scope.connectionId);
    expect(new Set(ids).size).toBe(2);
    await s.tick(); // end of the list: starts over
    await s.tick();
    expect(await s.tick()).toMatchObject({ deduplicated: 1 });
  });

  it('enqueues ad_poll only for connections with due sources, on the connection platform', async () => {
    await recordAdOnBoth();
    await scheduler().tick();
    const polls = ofType('ad_poll');
    expect(polls.map((p) => p.platform).sort()).toEqual(['facebook', 'instagram']);
    expect(polls.map((p) => p.scope.connectionId)).not.toContain(fbB.connectionId);
  });

  it('skips revoked and reconnect_required connections', async () => {
    await recordAdOnBoth();
    await setStatus(adsA, 'reconnect_required');
    await setStatus(adsB, 'revoked');
    await setStatus(fbA, 'reconnect_required');
    await setStatus(igA, 'revoked');
    expect(await scheduler().tick()).toMatchObject({ discovery: 0, poll: 0, failed: 0 });
  });

  it('a failing enqueue does not stop the tick', async () => {
    failFirst = true;
    const r = await scheduler().tick();
    expect(r).toMatchObject({ failed: 1, discovery: 1 });
    expect(warnings).toEqual(['scheduler.enqueue_failed']);
  });

  it('stop awaits an in-flight tick and halts the timer', async () => {
    const s = scheduler();
    s.start();
    await s.stop();
    await expect(s.stop()).resolves.toBeUndefined();
  });
});
