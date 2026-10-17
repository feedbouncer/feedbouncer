import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { PgAlertChannels } from './channels.js';
import { seedChannel, seedFlags } from './testing.js';
import { DEFAULT_SETTINGS, PgAlertSettings } from './settings.js';

const WEBHOOK = 'https://hooks.slack.com/services/TABC12345/BXYZ98765/sentinelHookSecret1234';
let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
let settings: PgAlertSettings;
let chA: string;
let chB: string;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
  a = await seedTenant(h.c, 'a');
  b = await seedTenant(h.c, 'b');
  settings = new PgAlertSettings(pool);
  const channels = new PgAlertChannels(pool, testKeyring(['k1']));
  const mk = async (t: Tenant) => {
    const r = await channels.createSlack(t.organizationId, t.userId, {
      label: 'S',
      webhookUrl: WEBHOOK,
    });
    if (r.status !== 'created') throw new Error(r.status);
    return r.channel.id;
  };
  chA = await mk(a);
  chB = await mk(b);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const custom = {
  sensitivity: 'high',
  minNegativeCount: 5,
  cooldownMinutes: 60,
  contentMode: 'counts_only',
} as const;
const enabledAt = async () =>
  (await h.c.query('SELECT enabled, enabled_at FROM alert_route WHERE brand_id = $1', [a.brandId]))
    .rows[0];

describe('PgAlertSettings', () => {
  it('returns defaults, no routes and learning when nothing is stored', async () => {
    expect(await settings.get(a.organizationId, a.brandId)).toEqual({
      settings: DEFAULT_SETTINGS,
      routes: [],
      learning: true,
    });
    expect(DEFAULT_SETTINGS).toEqual({
      sensitivity: 'medium',
      minNegativeCount: 10,
      cooldownMinutes: 360,
      contentMode: 'excerpts',
    });
  });

  it('refuses a channel from another org and writes nothing', async () => {
    const r = await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [{ alertType: 'negative_spike', channelId: chB, enabled: true }],
    });
    expect(r).toEqual({ status: 'unknown_channel' });
    expect((await h.c.query('SELECT 1 FROM alert_brand_settings')).rowCount).toBe(0);
    expect((await h.c.query('SELECT 1 FROM alert_route')).rowCount).toBe(0);
    expect(
      (await h.c.query("SELECT 1 FROM audit_event WHERE action = 'alert.settings_updated'"))
        .rowCount,
    ).toBe(0);
  });

  it('refuses malformed channel ids', async () => {
    const r = await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [{ alertType: 'negative_spike', channelId: 'not-a-uuid', enabled: true }],
    });
    expect(r).toEqual({ status: 'unknown_channel' });
  });

  it('refuses another org brand and leaves its rows untouched', async () => {
    const before = await h.c.query('SELECT count(*)::int AS n FROM alert_brand_settings');
    const r = await settings.put(a.organizationId, b.brandId, a.userId, {
      settings: custom,
      routes: [{ alertType: 'negative_spike', channelId: chA, enabled: true }],
    });
    expect(r).toEqual({ status: 'unknown_brand' });
    expect((await h.c.query('SELECT count(*)::int AS n FROM alert_brand_settings')).rows).toEqual(
      before.rows,
    );
    for (const t of ['alert_route', 'alert_brand_state'])
      expect(
        (await h.c.query(`SELECT 1 FROM ${t} WHERE brand_id = $1`, [b.brandId])).rowCount,
      ).toBe(0);

    await settings.put(b.organizationId, b.brandId, b.userId, {
      settings: DEFAULT_SETTINGS,
      routes: [],
    });
    const bRow = await h.c.query('SELECT * FROM alert_brand_settings WHERE brand_id = $1', [
      b.brandId,
    ]);
    await settings.put(a.organizationId, b.brandId, a.userId, { settings: custom, routes: [] });
    expect(
      (await h.c.query('SELECT * FROM alert_brand_settings WHERE brand_id = $1', [b.brandId])).rows,
    ).toEqual(bRow.rows);
  });

  it('refuses an archived brand', async () => {
    const c = await seedTenant(h.c, 'c');
    await h.c.query('UPDATE brand SET archived_at = now() WHERE id = $1', [c.brandId]);
    expect(
      await settings.put(c.organizationId, c.brandId, c.userId, { settings: custom, routes: [] }),
    ).toEqual({
      status: 'unknown_brand',
    });
  });

  it('sets enabled_at only on false → true, drops unlisted routes, and creates brand state', async () => {
    const route = (enabled: boolean) => ({
      alertType: 'negative_spike' as const,
      channelId: chA,
      enabled,
    });
    await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [route(false)],
    });
    expect((await enabledAt()).enabled_at).toBeNull();
    expect(
      (await h.c.query('SELECT 1 FROM alert_brand_state WHERE brand_id = $1', [a.brandId]))
        .rowCount,
    ).toBe(0);

    await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [route(true)],
    });
    const first = (await enabledAt()).enabled_at as Date;
    expect(first).toBeInstanceOf(Date);
    expect(
      (await h.c.query('SELECT 1 FROM alert_brand_state WHERE brand_id = $1', [a.brandId]))
        .rowCount,
    ).toBe(1);

    await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [route(true)],
    });
    expect((await enabledAt()).enabled_at).toEqual(first);

    await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [route(false)],
    });
    await settings.put(a.organizationId, a.brandId, a.userId, {
      settings: custom,
      routes: [route(true)],
    });
    expect(((await enabledAt()).enabled_at as Date).getTime()).toBeGreaterThanOrEqual(
      first.getTime(),
    );

    const got = await settings.get(a.organizationId, a.brandId);
    expect(got.settings).toEqual(custom);
    expect(got.routes).toEqual([route(true)]);
    expect(got.learning).toBe(true);

    await settings.put(a.organizationId, a.brandId, a.userId, { settings: custom, routes: [] });
    expect((await settings.get(a.organizationId, a.brandId)).routes).toEqual([]);
  });

  it('reports learning false once the verdict has moved on, and audits without values', async () => {
    await h.c.query("UPDATE alert_brand_state SET last_verdict = 'below_min' WHERE brand_id = $1", [
      a.brandId,
    ]);
    expect((await settings.get(a.organizationId, a.brandId)).learning).toBe(false);
    const ev = await h.c.query(
      "SELECT details::text AS d FROM audit_event WHERE action = 'alert.settings_updated'",
    );
    expect(ev.rowCount).toBeGreaterThan(0);
    expect(ev.rows.map((x) => x.d).join('')).not.toMatch(/hooks\.slack|@/);
  });

  it('removeBrand clears the brand alert data and cancels open deliveries, leaving other brands alone', async () => {
    const seed = async (t: Tenant, channelId: string) => {
      const [itemId] = await seedFlags(h.c, t, { count: 1, createdAt: new Date() });
      const [commentId] = (
        await h.c.query<{ comment_id: string }>(
          'SELECT comment_id FROM review_item WHERE id = $1',
          [itemId],
        )
      ).rows;
      await h.c.query(
        `INSERT INTO alert_flag_item (organization_id, brand_id, review_item_id, comment_id, flagged_at)
         VALUES ($1, $2, $3, $4, now())`,
        [t.organizationId, t.brandId, itemId, commentId!.comment_id],
      );
      await h.c.query(
        'INSERT INTO alert_brand_state (organization_id, brand_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [t.organizationId, t.brandId],
      );
      await h.c.query(
        `INSERT INTO alert_negative_hourly (organization_id, brand_id, hour, negatives, total)
         VALUES ($1, $2, date_trunc('hour', now()), 1, 2)`,
        [t.organizationId, t.brandId],
      );
      const ev = await h.c.query<{ id: string }>(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', $3, 'queued', '{}') RETURNING id`,
        [t.organizationId, t.brandId, `k:${t.brandId}`],
      );
      for (const state of ['pending', 'retrying', 'sent']) {
        const ch = await seedChannel(h.c, t, 'email');
        await h.c.query(
          'INSERT INTO alert_delivery (organization_id, alert_event_id, channel_id, state) VALUES ($1, $2, $3, $4)',
          [t.organizationId, ev.rows[0]!.id, ch, state],
        );
      }
      await settings.put(t.organizationId, t.brandId, t.userId, {
        settings: DEFAULT_SETTINGS,
        routes: [{ alertType: 'flagged_item', channelId, enabled: true }],
      });
    };
    await seed(a, chA);
    await seed(b, chB);
    const c = await pool.connect();
    try {
      await settings.removeBrand(c, a.organizationId, a.brandId);
    } finally {
      c.release();
    }
    const count = async (t: string, brandId: string) =>
      (await h.c.query(`SELECT 1 FROM ${t} WHERE brand_id = $1`, [brandId])).rowCount;
    for (const t of [
      'alert_brand_settings',
      'alert_route',
      'alert_brand_state',
      'alert_negative_hourly',
      'alert_flag_item',
    ]) {
      expect(await count(t, a.brandId), t).toBe(0);
      expect(await count(t, b.brandId), t).toBeGreaterThan(0);
    }
    const states = async (t: Tenant) =>
      (
        await h.c.query<{ state: string }>(
          `SELECT d.state FROM alert_delivery d JOIN alert_event e ON e.id = d.alert_event_id
            WHERE e.brand_id = $1 ORDER BY d.state`,
          [t.brandId],
        )
      ).rows.map((r) => r.state);
    expect(await states(a)).toEqual(['cancelled', 'cancelled', 'sent']);
    expect(await states(b)).toEqual(['pending', 'retrying', 'sent']);
  });
});
