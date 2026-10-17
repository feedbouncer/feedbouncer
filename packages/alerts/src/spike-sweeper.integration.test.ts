import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { Logger } from '@feedbouncer/service-runtime';
import { evaluateSpike } from './spike.js';
import { SpikeSweeper, WINDOW_SQL } from './spike-sweeper.js';
import { enableRoute, seedChannel, seedNegativeComments } from './testing.js';

const NOW = new Date('2026-10-17T10:30:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW.getTime() + ms);

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
});
afterEach(async () => {
  await h.c.query('DELETE FROM alert_brand_state');
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const sweeper = (o: { now?: Date; log?: Logger; evaluate?: typeof evaluateSpike } = {}) =>
  new SpikeSweeper({
    pool,
    log: o.log ?? logger(),
    capPerHour: 100,
    now: () => o.now ?? NOW,
    ...(o.evaluate ? { evaluate: o.evaluate } : {}),
  });

// 14 days of 10 live comments per hour, 2 of them negative; the first live comment is 20 days old.
async function background(t: Tenant): Promise<void> {
  const hourStart = new Date(Math.floor(NOW.getTime() / HOUR) * HOUR);
  await h.c.query(
    `WITH ins AS (
       INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at, ingested_at)
       SELECT $1, $2, $3, $4, 'bg-' || hr || '-' || i, 'bg', p, p
         FROM generate_series(2, 336) hr, generate_series(1, 10) i,
              LATERAL (SELECT $5::timestamptz - hr * interval '1 hour' + i * interval '1 minute' AS p) x
       RETURNING id, external_id)
     INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider,
       classifier_model, reason)
     SELECT $1, $2, id, 'hide', 'enforce', 'classifier', 'test', 'test-model', 'bg'
       FROM ins WHERE right(external_id, 2) IN ('-1', '-2')`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, hourStart],
  );
  await seedNegativeComments(h.c, t, { count: 1, postedAt: at(-20 * DAY), outcome: 'approve' });
}

async function arm(t: Tenant): Promise<void> {
  await h.c.query(
    `INSERT INTO alert_brand_state (organization_id, brand_id, next_eval_at) VALUES ($1, $2, '2000-01-01')`,
    [t.organizationId, t.brandId],
  );
}

async function brand(o: { background?: boolean; route?: boolean } = {}): Promise<Tenant> {
  const t = await seedTenant(h.c, `spike-${++seq}`);
  if (o.background ?? true) await background(t);
  if (o.route ?? true)
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack'));
  await arm(t);
  return t;
}

const events = (t: Tenant) =>
  h.c
    .query<{
      id: string;
      alert_type: string;
      alert_key: string;
      payload: Record<string, unknown>;
    }>(
      'SELECT id, alert_type, alert_key, payload FROM alert_event WHERE organization_id = $1 ORDER BY created_at, alert_type',
      [t.organizationId],
    )
    .then((r) => r.rows);

const state = (t: Tenant) =>
  h.c
    .query<{
      last_verdict: string | null;
      next_eval_at: Date;
      first_live_at: Date | null;
    }>(
      'SELECT last_verdict, next_eval_at, first_live_at FROM alert_brand_state WHERE brand_id = $1',
      [t.brandId],
    )
    .then((r) => r.rows[0]!);

const negatives = (t: Tenant, count: number, postedAt = at(-5 * MIN)) =>
  seedNegativeComments(h.c, t, { count, postedAt });

describe('SpikeSweeper', () => {
  it('12 negative comments in the last hour → one negative_spike event with deliveries', async () => {
    const t = await brand();
    const ids = await negatives(t, 12);
    const log = logger();
    expect(await sweeper({ log }).tick()).toEqual({ evaluated: 1, fired: 1, escalated: 0 });

    const ev = await events(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.alert_type).toBe('negative_spike');
    expect(ev[0]!.alert_key).toMatch(new RegExp(`^spike:${t.brandId}:[0-9a-f-]{36}$`));
    expect(ev[0]!.payload).toMatchObject({
      kind: 'spike',
      negatives: 12,
      total: 12,
      expectedPerHour: 2,
      trigger: 'volume',
      sensitivity: 'medium',
      minCount: 10,
      connectionIds: [t.connectionId],
      connectionCount: 1,
    });
    const commentIds = ev[0]!.payload.commentIds as string[];
    expect(commentIds).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(commentIds));
    const d = await h.c.query(
      "SELECT 1 FROM alert_delivery WHERE alert_event_id = $1 AND state = 'pending'",
      [ev[0]!.id],
    );
    expect(d.rowCount).toBe(1);
    expect((await state(t)).last_verdict).toBe('fired');
    expect(log.info).toHaveBeenCalledWith('alerts.spike_tick', {
      evaluated: 1,
      fired: 1,
      escalated: 0,
    });
  });

  it('9 negatives (below min 10) → no event', async () => {
    const t = await brand();
    await negatives(t, 9);
    expect(await sweeper().tick()).toEqual({ evaluated: 1, fired: 0, escalated: 0 });
    expect(await events(t)).toEqual([]);
    expect((await state(t)).last_verdict).toBe('below_min');
  });

  it('suggest-mode decisions do not count: 50 suggested hides → no event', async () => {
    const t = await brand();
    await seedNegativeComments(h.c, t, { count: 50, postedAt: at(-5 * MIN), mode: 'suggest' });
    await sweeper().tick();
    expect(await events(t)).toEqual([]);
    expect((await state(t)).last_verdict).toBe('below_min');
  });

  it('backfill does not count: 50 recent backfilled negatives → no event', async () => {
    const t = await brand();
    await seedNegativeComments(h.c, t, { count: 50, postedAt: at(-5 * MIN), origin: 'backfill' });
    await sweeper().tick();
    expect(await events(t)).toEqual([]);
    expect((await state(t)).last_verdict).toBe('below_min');
  });

  it('live comments posted 3 days ago but ingested now (late poll) → not in window, no event', async () => {
    const t = await brand();
    await seedNegativeComments(h.c, t, { count: 50, postedAt: at(-3 * DAY), ingestedAt: NOW });
    await sweeper().tick();
    expect(await events(t)).toEqual([]);
    expect((await state(t)).last_verdict).toBe('below_min');
  });

  it('cooldown: no repeat, one escalation at twice the trigger count, new spike after cooldown', async () => {
    const t = await brand();
    await negatives(t, 12, at(-1 * MIN));
    expect(await sweeper().tick()).toMatchObject({ fired: 1 });

    await negatives(t, 3, at(4 * MIN));
    expect(await sweeper({ now: at(5 * MIN) }).tick()).toEqual({
      evaluated: 1,
      fired: 0,
      escalated: 0,
    });
    expect((await state(t)).last_verdict).toBe('cooldown');
    expect(await events(t)).toHaveLength(1);

    await negatives(t, 9, at(9 * MIN));
    expect(await sweeper({ now: at(10 * MIN) }).tick()).toEqual({
      evaluated: 1,
      fired: 0,
      escalated: 1,
    });
    const ev = await events(t);
    expect(ev.map((e) => e.alert_type)).toEqual(['negative_spike', 'spike_escalation']);
    const episode = ev[0]!.alert_key.split(':')[2];
    expect(ev[1]!.alert_key).toBe(`spike_escalation:${episode}`);
    expect(ev[1]!.payload).toMatchObject({ negatives: 24, triggerCount: 12 });
    expect((await state(t)).last_verdict).toBe('escalated');

    await negatives(t, 16, at(14 * MIN));
    expect(await sweeper({ now: at(15 * MIN) }).tick()).toMatchObject({ fired: 0, escalated: 0 });
    expect(await events(t)).toHaveLength(2);

    await negatives(t, 12, at(6 * HOUR + 4 * MIN));
    expect(await sweeper({ now: at(6 * HOUR + 5 * MIN) }).tick()).toMatchObject({ fired: 1 });
    const after = await events(t);
    expect(after.map((e) => e.alert_type)).toEqual([
      'negative_spike',
      'spike_escalation',
      'negative_spike',
    ]);
    expect(after[2]!.alert_key).not.toBe(after[0]!.alert_key);
  });

  it('learning: brand with first live comment 3 days ago → no event, last_verdict learning', async () => {
    const t = await brand({ background: false });
    await seedNegativeComments(h.c, t, { count: 5, postedAt: at(-3 * DAY), outcome: 'approve' });
    await negatives(t, 30);
    await sweeper().tick();
    expect(await events(t)).toEqual([]);
    expect((await state(t)).last_verdict).toBe('learning');
  });

  it('own-account comments do not start the learning clock', async () => {
    const t = await brand({ background: false });
    const own = await seedNegativeComments(h.c, t, {
      count: 1,
      postedAt: at(-20 * DAY),
      outcome: 'approve',
    });
    await h.c.query('UPDATE comment SET is_own_account = true WHERE id = ANY($1)', [own]);
    await seedNegativeComments(h.c, t, { count: 5, postedAt: at(-3 * DAY), outcome: 'approve' });
    await negatives(t, 30);
    await sweeper().tick();
    expect(await events(t)).toEqual([]);
    expect(await state(t)).toMatchObject({ last_verdict: 'learning', first_live_at: at(-3 * DAY) });
  });

  it('rollup covers the hours between evaluations after a gap', async () => {
    const t = await brand();
    expect(await sweeper().tick()).toMatchObject({ evaluated: 1 });
    for (const hr of [11, 12, 13]) {
      const postedAt = new Date(`2026-10-17T${hr}:10:00.000Z`);
      await seedNegativeComments(h.c, t, { count: 200, postedAt });
      await seedNegativeComments(h.c, t, { count: 300, postedAt, outcome: 'approve' });
    }
    // Ten negatives of 100 would be a volume spike against a baseline missing the busy hours.
    await negatives(t, 10, at(6 * HOUR - 5 * MIN));
    await seedNegativeComments(h.c, t, {
      count: 90,
      postedAt: at(6 * HOUR - 5 * MIN),
      outcome: 'approve',
    });
    expect(await sweeper({ now: at(6 * HOUR) }).tick()).toEqual({
      evaluated: 1,
      fired: 0,
      escalated: 0,
    });
    const rows = await h.c.query<{ hour: Date; negatives: number; total: number }>(
      `SELECT hour, negatives, total FROM alert_negative_hourly
        WHERE brand_id = $1 AND hour >= '2026-10-17T11:00Z' AND hour < '2026-10-17T14:00Z' ORDER BY hour`,
      [t.brandId],
    );
    expect(rows.rows).toEqual(
      [11, 12, 13].map((hr) => ({
        hour: new Date(`2026-10-17T${hr}:00:00.000Z`),
        negatives: 200,
        total: 500,
      })),
    );
    expect((await state(t)).last_verdict).toBe('within_baseline');
    expect(await events(t)).toEqual([]);
  });

  it('reprocessing: duplicate decisions for the same comments do not change N', async () => {
    const t = await brand();
    const ids = await negatives(t, 12);
    await h.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider,
         classifier_model, reason)
       SELECT $1, $2, id, o, 'enforce', 'classifier', 'test', 'test-model', 'rerun'
         FROM unnest($3::uuid[]) id, unnest(ARRAY['hide', 'flag']) o`,
      [t.organizationId, t.brandId, ids],
    );
    await sweeper().tick();
    const ev = await events(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ negatives: 12, total: 12 });
  });

  it('two sweepers in parallel → one spike event', async () => {
    const t = await brand();
    await negatives(t, 12);
    const results = await Promise.all([sweeper().tick(), sweeper().tick()]);
    expect(results.reduce((n, r) => n + r.evaluated, 0)).toBe(1);
    expect(await events(t)).toHaveLength(1);
  });

  it('archived brand or no enabled spike route → not claimed', async () => {
    const archived = await brand();
    await negatives(archived, 12);
    await h.c.query('UPDATE brand SET archived_at = now() WHERE id = $1', [archived.brandId]);
    const noRoute = await brand({ route: false });
    await negatives(noRoute, 12);
    const disabled = await brand({ route: false });
    await enableRoute(
      h.c,
      disabled,
      'negative_spike',
      await seedChannel(h.c, disabled, 'slack'),
      false,
    );
    const flagOnly = await brand({ route: false });
    await enableRoute(h.c, flagOnly, 'flagged_item', await seedChannel(h.c, flagOnly, 'slack'));
    const inactive = await brand({ route: false });
    await enableRoute(
      h.c,
      inactive,
      'negative_spike',
      await seedChannel(h.c, inactive, 'slack', 'disconnected'),
    );

    expect(await sweeper().tick()).toEqual({ evaluated: 0, fired: 0, escalated: 0 });
    for (const t of [archived, noRoute, disabled, flagOnly, inactive]) {
      expect(await events(t)).toEqual([]);
      expect(await state(t)).toMatchObject({ last_verdict: null });
    }
  });

  it("org B's negatives never counted for org A's brand", async () => {
    const a = await brand();
    const b = await brand({ route: false });
    await negatives(a, 9);
    await negatives(b, 50);
    await seedNegativeComments(h.c, b, { count: 40, postedAt: at(-2 * HOUR - 5 * MIN) });
    await sweeper().tick();
    expect(await events(a)).toEqual([]);
    expect(await events(b)).toEqual([]);
    expect((await state(a)).last_verdict).toBe('below_min');
    const rollup = await h.c.query<{ negatives: number }>(
      'SELECT negatives FROM alert_negative_hourly WHERE organization_id = $1 AND hour = $2',
      [a.organizationId, new Date('2026-10-17T08:00:00.000Z')],
    );
    expect(rollup.rows).toEqual([{ negatives: 2 }]);
    const leaked = await h.c.query(
      'SELECT 1 FROM alert_negative_hourly WHERE organization_id = $1',
      [b.organizationId],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('one brand throwing does not stop the other brand', async () => {
    const bad = await brand();
    const good = await brand();
    await h.c.query(
      `INSERT INTO alert_brand_settings (organization_id, brand_id, min_negative_count) VALUES ($1, $2, 11)`,
      [bad.organizationId, bad.brandId],
    );
    await negatives(bad, 12);
    await negatives(good, 12);
    const log = logger();
    const evaluate: typeof evaluateSpike = (i) => {
      if (i.minCount === 11) throw new Error('boom');
      return evaluateSpike(i);
    };
    expect(await sweeper({ log, evaluate }).tick()).toEqual({
      evaluated: 1,
      fired: 1,
      escalated: 0,
    });
    expect(await events(bad)).toEqual([]);
    expect(await events(good)).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'alerts.spike_failed',
      expect.objectContaining({ brandId: bad.brandId, error: 'Error' }),
    );
    expect((await state(bad)).next_eval_at.getTime()).toBe(at(5 * MIN).getTime());
  });

  it('rollup hours are whole UTC hours under a half-hour session time zone', async () => {
    const t = await brand();
    await negatives(t, 12);
    const kolkata = new pg.Pool({
      connectionString: h.db.url.href,
      options: '-c TimeZone=Asia/Kolkata',
    });
    try {
      const s = new SpikeSweeper({ pool: kolkata, log: logger(), capPerHour: 100, now: () => NOW });
      expect(await s.tick()).toMatchObject({ evaluated: 1, fired: 1 });
    } finally {
      await kolkata.end();
    }
    const off = await h.c.query(
      `SELECT 1 FROM alert_negative_hourly
        WHERE brand_id = $1 AND extract(epoch FROM hour)::bigint % 3600 <> 0`,
      [t.brandId],
    );
    expect(off.rowCount).toBe(0);
  });

  it('EXPLAIN of the window query uses comment_organization_id_brand_id_posted_at_live_idx', async () => {
    const t = await brand();
    await h.c.query('BEGIN');
    try {
      // The scratch table is small enough that the planner would otherwise prefer a seq scan.
      await h.c.query('SET LOCAL enable_seqscan = off');
      const plan = await h.c.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${WINDOW_SQL}`, [
        t.organizationId,
        t.brandId,
        at(-HOUR),
        NOW,
      ]);
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        'comment_organization_id_brand_id_posted_at_live_idx',
      );
    } finally {
      await h.c.query('ROLLBACK');
    }
  });
});
