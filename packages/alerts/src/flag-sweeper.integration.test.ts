import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { FlagSweeper } from './flag-sweeper.js';
import { enableRoute, seedChannel, seedFlags, seedNegativeComments } from './testing.js';

const NOW = new Date('2026-10-17T10:30:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
});
afterEach(async () => {
  await h.c.query('DELETE FROM alert_flag_item');
  await h.c.query('DELETE FROM review_item');
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const sweeper = (now: Date = NOW, log = logger()) =>
  new FlagSweeper({ pool, log, capPerHour: 100, now: () => now });

async function brand(o: { route?: boolean; enabledAt?: Date } = {}): Promise<Tenant> {
  const t = await seedTenant(h.c, `flag-${++seq}`);
  if (o.route ?? true) {
    await enableRoute(h.c, t, 'flagged_item', await seedChannel(h.c, t, 'slack'));
    await h.c.query('UPDATE alert_route SET enabled_at = $2 WHERE brand_id = $1', [
      t.brandId,
      o.enabledAt ?? at(-HOUR),
    ]);
  }
  return t;
}

const events = (t: Tenant) =>
  h.c
    .query<{
      id: string;
      alert_type: string;
      alert_key: string;
      window_start: Date;
      window_end: Date;
      payload: { kind: string; reviewItemIds: string[]; count: number };
    }>(
      'SELECT id, alert_type, alert_key, window_start, window_end, payload FROM alert_event WHERE organization_id = $1 ORDER BY created_at, id',
      [t.organizationId],
    )
    .then((r) => r.rows);

const items = (t: Tenant, state: string) =>
  h.c
    .query<{
      review_item_id: string;
      alert_event_id: string | null;
    }>(
      'SELECT review_item_id, alert_event_id FROM alert_flag_item WHERE brand_id = $1 AND state = $2',
      [t.brandId, state],
    )
    .then((r) => r.rows);

const resolve = (ids: string[]) =>
  h.c.query(
    "UPDATE review_item SET status = 'resolved', resolution = 'approved', resolved_at = now() WHERE id = ANY($1::uuid[])",
    [ids],
  );

describe('FlagSweeper', () => {
  it('3 flags within 60 s → one digest after the batch window, count 3', async () => {
    const t = await brand();
    const ids = [
      ...(await seedFlags(h.c, t, { count: 1, createdAt: at(-200 * SEC) })),
      ...(await seedFlags(h.c, t, { count: 1, createdAt: at(-170 * SEC) })),
      ...(await seedFlags(h.c, t, { count: 1, createdAt: at(-140 * SEC) })),
    ];
    const log = logger();
    expect(await sweeper(NOW, log).tick()).toEqual({ collected: 3, digests: 1, skipped: 0 });

    const ev = await events(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.alert_type).toBe('flagged_digest');
    expect(ev[0]!.alert_key).toMatch(new RegExp(`^flags:${t.brandId}:[0-9a-f]{32}$`));
    expect(ev[0]!.payload).toEqual({ kind: 'flags', reviewItemIds: [...ids].sort(), count: 3 });
    expect(ev[0]!.window_start).toEqual(at(-200 * SEC));
    expect(ev[0]!.window_end).toEqual(at(-140 * SEC));
    const included = await items(t, 'included');
    expect(included).toHaveLength(3);
    expect(included.every((i) => i.alert_event_id === ev[0]!.id)).toBe(true);
    const d = await h.c.query(
      "SELECT 1 FROM alert_delivery WHERE alert_event_id = $1 AND state = 'pending'",
      [ev[0]!.id],
    );
    expect(d.rowCount).toBe(1);
    expect(log.info).toHaveBeenCalledWith('alerts.flag_tick', {
      collected: 3,
      digests: 1,
      skipped: 0,
    });
  });

  it('a flag opened 30 s ago is collected but not dispatched yet', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 1, createdAt: at(-30 * SEC) });
    expect(await sweeper().tick()).toEqual({ collected: 1, digests: 0, skipped: 0 });
    expect(await events(t)).toHaveLength(0);
    expect(await items(t, 'pending')).toHaveLength(1);
  });

  it('a flag arriving after the digest closed goes into the next digest', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 1, createdAt: at(-5 * MIN) });
    expect((await sweeper().tick()).digests).toBe(1);
    const late = await seedFlags(h.c, t, { count: 1, createdAt: at(-10 * SEC) });
    expect(await sweeper().tick()).toEqual({ collected: 1, digests: 0, skipped: 0 });
    expect(await sweeper(at(3 * MIN)).tick()).toEqual({ collected: 0, digests: 1, skipped: 0 });
    const ev = await events(t);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.payload.reviewItemIds).toEqual(late);
  });

  it('flags resolved before the batch closes are skipped and produce no event', async () => {
    const t = await brand();
    const ids = await seedFlags(h.c, t, { count: 2, createdAt: at(-5 * MIN) });
    await sweeper(at(-4 * MIN)).tick();
    await resolve(ids);
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 2 });
    expect(await events(t)).toHaveLength(0);
    expect(await items(t, 'skipped')).toHaveLength(2);
  });

  it('route disabled before the batch closes → items skipped, no event', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 2, createdAt: at(-5 * MIN) });
    await sweeper(at(-4 * MIN)).tick();
    await h.c.query('UPDATE alert_route SET enabled = false WHERE brand_id = $1', [t.brandId]);
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 2 });
    expect(await events(t)).toHaveLength(0);
    expect(await items(t, 'skipped')).toHaveLength(2);
  });

  it('one of three resolved → digest of 2', async () => {
    const t = await brand();
    const ids = await seedFlags(h.c, t, { count: 3, createdAt: at(-5 * MIN) });
    await sweeper(at(-4 * MIN)).tick();
    await resolve([ids[0]!]);
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 1, skipped: 1 });
    const ev = await events(t);
    expect(ev[0]!.payload.count).toBe(2);
    expect(ev[0]!.payload.reviewItemIds).toEqual(ids.slice(1).sort());
    expect((await items(t, 'skipped')).map((i) => i.review_item_id)).toEqual([ids[0]]);
  });

  it('the same review_item seen by two ticks → one alert_flag_item, one digest', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 1, createdAt: at(-5 * MIN) });
    expect(await sweeper(at(-4 * MIN)).tick()).toMatchObject({ collected: 1, digests: 0 });
    expect(await sweeper().tick()).toMatchObject({ collected: 0, digests: 1 });
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 0 });
    expect(await events(t)).toHaveLength(1);
    expect(
      (await h.c.query('SELECT 1 FROM alert_flag_item WHERE brand_id = $1', [t.brandId])).rowCount,
    ).toBe(1);
  });

  it('an existing event with the same key is reused and the items are still included', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 2, createdAt: at(-5 * MIN) });
    await sweeper().tick();
    const [first] = await events(t);
    await h.c.query(
      "UPDATE alert_flag_item SET state = 'pending', alert_event_id = NULL WHERE brand_id = $1",
      [t.brandId],
    );
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 0 });
    expect(await events(t)).toHaveLength(1);
    expect((await items(t, 'included')).every((i) => i.alert_event_id === first!.id)).toBe(true);
  });

  it('review_item on a backfill comment → not collected', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 1, createdAt: at(-5 * MIN), origin: 'backfill' });
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 0 });
  });

  it('flags created before the route was enabled → not collected', async () => {
    const t = await brand({ enabledAt: at(-2 * MIN) });
    await seedFlags(h.c, t, { count: 2, createdAt: at(-5 * MIN) });
    const after = await seedFlags(h.c, t, { count: 1, createdAt: at(-90 * SEC) });
    expect(await sweeper().tick()).toEqual({ collected: 1, digests: 0, skipped: 0 });
    expect((await items(t, 'pending')).map((i) => i.review_item_id)).toEqual(after);
  });

  it('flags older than 24 h and flags on brands without a route are not collected', async () => {
    const old = await brand();
    await seedFlags(h.c, old, { count: 1, createdAt: at(-25 * HOUR) });
    const bare = await brand({ route: false });
    await seedFlags(h.c, bare, { count: 1, createdAt: at(-5 * MIN) });
    expect(await sweeper().tick()).toEqual({ collected: 0, digests: 0, skipped: 0 });
  });

  it('moderator flag (user decision, outcome flag, enforce) → collected via the existing trigger', async () => {
    const t = await brand();
    const [commentId] = await seedNegativeComments(h.c, t, {
      count: 1,
      postedAt: at(-5 * MIN),
      outcome: 'approve',
    });
    await h.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason)
       VALUES ($1, $2, $3, 'flag', 'enforce', 'user', $4, 'moderator flag')`,
      [t.organizationId, t.brandId, commentId, t.userId],
    );
    const ri = await h.c.query<{ id: string }>('SELECT id FROM review_item WHERE comment_id = $1', [
      commentId,
    ]);
    await h.c.query('UPDATE review_item SET created_at = $2 WHERE id = $1', [
      ri.rows[0]!.id,
      at(-5 * MIN),
    ]);
    expect(await sweeper().tick()).toEqual({ collected: 1, digests: 1, skipped: 0 });
    expect((await events(t))[0]!.payload.reviewItemIds).toEqual([ri.rows[0]!.id]);
  });

  it('150 flags → digests of 100 and 50 in one tick', async () => {
    const t = await brand();
    await seedFlags(h.c, t, { count: 150, createdAt: at(-5 * MIN) });
    expect(await sweeper().tick()).toEqual({ collected: 150, digests: 2, skipped: 0 });
    const ev = await events(t);
    expect(ev.map((e) => e.payload.count).sort((a, b) => b - a)).toEqual([100, 50]);
    expect(await items(t, 'included')).toHaveLength(150);
  });

  it('org B flags never reach org A routes', async () => {
    const a = await brand();
    const b = await brand({ route: false });
    await seedFlags(h.c, a, { count: 1, createdAt: at(-5 * MIN) });
    await seedFlags(h.c, b, { count: 2, createdAt: at(-5 * MIN) });
    expect(await sweeper().tick()).toEqual({ collected: 1, digests: 1, skipped: 0 });
    expect((await events(a))[0]!.payload.count).toBe(1);
    expect(await events(b)).toHaveLength(0);
    expect(await items(b, 'pending')).toHaveLength(0);
  });

  it('a failing brand is logged and does not stop the others', async () => {
    const bad = await brand();
    const good = await brand();
    await seedFlags(h.c, bad, { count: 1, createdAt: at(-5 * MIN) });
    await seedFlags(h.c, good, { count: 1, createdAt: at(-5 * MIN) });
    await h.c.query(`CREATE FUNCTION pg_temp.fail_bad() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await h.c.query(
      `CREATE TRIGGER fail_bad_trg BEFORE INSERT ON alert_event FOR EACH ROW
         WHEN (NEW.brand_id = '${bad.brandId}') EXECUTE FUNCTION pg_temp.fail_bad()`,
    );
    const log = logger();
    try {
      expect((await sweeper(NOW, log).tick()).digests).toBe(1);
    } finally {
      await h.c.query('DROP TRIGGER fail_bad_trg ON alert_event');
    }
    expect(await items(good, 'included')).toHaveLength(1);
    expect(await items(bad, 'pending')).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'alerts.flag_failed',
      expect.objectContaining({ brandId: bad.brandId }),
    );
  });
});
