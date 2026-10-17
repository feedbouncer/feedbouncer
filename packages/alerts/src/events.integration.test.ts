import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { createAlertEvent, type AlertEventType, type AlertPayload } from './events.js';
import { enableRoute, seedChannel } from './testing.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
const NOW = new Date('2026-10-17T10:30:00.000Z');
const HOUR = 3_600_000;
let seq = 0;

beforeAll(async () => {
  h = await migratedDb();
});
afterAll(async () => {
  await h.close();
});

const payload: AlertPayload = {
  kind: 'spike',
  negatives: 12,
  total: 40,
  expectedPerHour: 2,
  trigger: 'volume',
  sensitivity: 'medium',
  minCount: 10,
  commentIds: [],
  connectionIds: [],
  connectionCount: 1,
};

const make = (
  t: Tenant,
  o: {
    key?: string;
    type?: AlertEventType;
    now?: Date;
    cap?: number;
    routeType?: 'negative_spike' | 'flagged_item';
  } = {},
  client: pg.ClientBase = h.c,
) => {
  const now = o.now ?? NOW;
  return createAlertEvent(
    client,
    {
      organizationId: t.organizationId,
      brandId: t.brandId,
      type: o.type ?? 'negative_spike',
      key: o.key ?? `k-${++seq}`,
      windowStart: new Date(now.getTime() - HOUR),
      windowEnd: now,
      payload,
    },
    { capPerHour: o.cap ?? 100, routeType: o.routeType ?? 'negative_spike', now },
  );
};

const count = async (sql: string, v: unknown[]) =>
  Number((await h.c.query<{ n: string }>(sql, v)).rows[0]!.n);
const deliveries = (eventId: string) =>
  count('SELECT count(*) n FROM alert_delivery WHERE alert_event_id = $1', [eventId]);
const capEvents = (org: string) =>
  h.c.query<{ id: string; payload: { cap: number; resumesAt: string } }>(
    "SELECT id, payload FROM alert_event WHERE organization_id = $1 AND alert_type = 'cap_reached'",
    [org],
  );

describe('createAlertEvent', () => {
  it('same key twice gives one event, one delivery per channel, and a duplicate', async () => {
    const t = await seedTenant(h.c, 'dup');
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack'));
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'email'));
    const first = await make(t, { key: 'same' });
    const second = await make(t, { key: 'same' });
    expect(first).toMatchObject({ status: 'created', suppressed: false, deliveries: 2 });
    if (first.status !== 'created') throw new Error('unreachable');
    expect(second).toEqual({ status: 'duplicate', eventId: first.eventId });
    expect(
      await count('SELECT count(*) n FROM alert_event WHERE organization_id = $1', [
        t.organizationId,
      ]),
    ).toBe(1);
    expect(await deliveries(first.eventId)).toBe(2);
  });

  it('only enabled routes on active channels get deliveries', async () => {
    const t = await seedTenant(h.c, 'filter');
    const ok = await seedChannel(h.c, t, 'slack');
    await enableRoute(h.c, t, 'negative_spike', ok);
    await enableRoute(
      h.c,
      t,
      'negative_spike',
      await seedChannel(h.c, t, 'email', 'pending_confirmation'),
    );
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'email', 'unsubscribed'));
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack', 'disconnected'));
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack'), false);
    const r = await make(t);
    expect(r).toMatchObject({ status: 'created', deliveries: 1 });
    if (r.status !== 'created') throw new Error('unreachable');
    const rows = await h.c.query(
      'SELECT channel_id, state FROM alert_delivery WHERE alert_event_id = $1',
      [r.eventId],
    );
    expect(rows.rows).toEqual([{ channel_id: ok, state: 'pending' }]);
  });

  it('a negative_spike route does not receive a flagged_digest', async () => {
    const t = await seedTenant(h.c, 'type');
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack'));
    expect(await make(t, { type: 'flagged_digest', routeType: 'flagged_item' })).toMatchObject({
      status: 'created',
      deliveries: 0,
    });
  });

  it('suppresses past the cap with one cap_reached event heard once per channel', async () => {
    const t = await seedTenant(h.c, 'cap');
    const slack = await seedChannel(h.c, t, 'slack');
    const email = await seedChannel(h.c, t, 'email');
    await enableRoute(h.c, t, 'negative_spike', slack);
    await enableRoute(h.c, t, 'negative_spike', email);
    const first = await make(t, { cap: 3, now: new Date(NOW.getTime() - 20 * 60_000) });
    await make(t, { cap: 3 });
    await make(t, { cap: 3 });
    const fourth = await make(t, { cap: 3 });
    expect(fourth).toMatchObject({ status: 'created', suppressed: true, deliveries: 0 });
    if (fourth.status !== 'created' || first.status !== 'created') throw new Error('unreachable');
    expect(
      await count(
        "SELECT count(*) n FROM alert_event WHERE organization_id = $1 AND status = 'suppressed'",
        [t.organizationId],
      ),
    ).toBe(1);
    const caps = (await capEvents(t.organizationId)).rows;
    expect(caps).toHaveLength(1);
    expect(caps[0]!.payload).toMatchObject({
      kind: 'cap',
      cap: 3,
      resumesAt: new Date(NOW.getTime() - 20 * 60_000 + HOUR).toISOString(),
    });
    expect(await deliveries(caps[0]!.id)).toBe(2);
    expect(await deliveries(fourth.eventId)).toBe(0);
    await make(t, { cap: 3 });
    expect((await capEvents(t.organizationId)).rows).toHaveLength(1);
    expect(await deliveries(caps[0]!.id)).toBe(2);
  });

  it('tells every active channel in the workspace about the cap, whatever its routes', async () => {
    const a = await seedTenant(h.c, 'capws');
    const brandB = (
      await h.c.query<{ id: string }>(
        'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
        [a.organizationId, 'Brand B'],
      )
    ).rows[0]!.id;
    const b: Tenant = { ...a, brandId: brandB };
    const routedToB = await seedChannel(h.c, b, 'slack');
    await enableRoute(h.c, b, 'negative_spike', routedToB);
    const unrouted = await seedChannel(h.c, a, 'email');
    const routedToA = await seedChannel(h.c, a, 'slack');
    await enableRoute(h.c, a, 'negative_spike', routedToA);
    for (const [kind, status] of [
      ['email', 'pending_confirmation'],
      ['email', 'unsubscribed'],
      ['slack', 'disconnected'],
    ] as const) {
      await enableRoute(h.c, a, 'negative_spike', await seedChannel(h.c, a, kind, status));
    }
    await make(a, { cap: 1 });
    expect(await make(a, { cap: 1 })).toMatchObject({ suppressed: true });
    await make(a, { cap: 1 });
    const caps = (await capEvents(a.organizationId)).rows;
    expect(caps).toHaveLength(1);
    expect(Object.keys(caps[0]!.payload).sort()).toEqual(['cap', 'kind', 'resumesAt']);
    const row = await h.c.query<{ brand_id: string | null }>(
      'SELECT brand_id FROM alert_event WHERE id = $1',
      [caps[0]!.id],
    );
    expect(row.rows[0]!.brand_id).toBeNull();
    const targets = await h.c.query<{ channel_id: string }>(
      'SELECT channel_id FROM alert_delivery WHERE alert_event_id = $1',
      [caps[0]!.id],
    );
    expect(targets.rows.map((r) => r.channel_id).sort()).toEqual(
      [routedToB, unrouted, routedToA].sort(),
    );
  });

  it('counts the cap per organization', async () => {
    const a = await seedTenant(h.c, 'capa');
    const b = await seedTenant(h.c, 'capb');
    await enableRoute(h.c, b, 'negative_spike', await seedChannel(h.c, b, 'slack'));
    for (let i = 0; i < 3; i++) await make(a, { cap: 2 });
    expect(await make(b, { cap: 2 })).toMatchObject({ suppressed: false, deliveries: 1 });
    expect((await capEvents(b.organizationId)).rows).toHaveLength(0);
  });

  it('does not count an event older than an hour', async () => {
    const t = await seedTenant(h.c, 'old');
    await make(t, { cap: 1, now: new Date(NOW.getTime() - HOUR - 1000) });
    expect(await make(t, { cap: 1 })).toMatchObject({ status: 'created', suppressed: false });
  });

  it('20 concurrent creates with cap 5 queue exactly 5', async () => {
    const t = await seedTenant(h.c, 'conc');
    await enableRoute(h.c, t, 'negative_spike', await seedChannel(h.c, t, 'slack'));
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = new pg.Client({ connectionString: h.db.url.toString() });
        await c.connect();
        return c;
      }),
    );
    try {
      await Promise.all(
        clients.map(async (c) => {
          await c.query('BEGIN');
          await make(t, { cap: 5 }, c);
          await c.query('COMMIT');
        }),
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const q = (s: string) =>
      count(`SELECT count(*) n FROM alert_event WHERE organization_id = $1 AND ${s}`, [
        t.organizationId,
      ]);
    expect(await q("status = 'queued' AND alert_type <> 'cap_reached'")).toBe(5);
    expect(await q("status = 'suppressed'")).toBe(15);
    expect(await q("alert_type = 'cap_reached'")).toBe(1);
  });
});
