import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { AlertEventType, AlertPayload, CapPayload } from './events.js';
import { reviewLink, settingsLink, spikeLink } from './links.js';
import { seedFlags, seedNegativeComments } from './testing.js';
import { loadAlertView } from './view.js';

const web = new URL('https://app.example.test');
const T0 = new Date('2026-10-17T09:00:00.000Z');
const T1 = new Date('2026-10-17T10:00:00.000Z');

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
let sibling: Tenant;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
  a = await seedTenant(h.c, 'a', { timezone: 'America/New_York' });
  b = await seedTenant(h.c, 'b');
  sibling = await siblingBrand(a);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

/** A second brand (with its own connection and source) in the same organization as `t`. */
async function siblingBrand(t: Tenant): Promise<Tenant> {
  const one = async (sql: string, v: unknown[]) =>
    (await h.c.query<{ id: string }>(sql, v)).rows[0]!.id;
  const brandId = await one(
    'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
    [t.organizationId, 'Sibling'],
  );
  const connectionId = await one(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
     VALUES ($1, $2, 'instagram', $3, 'Sibling IG') RETURNING id`,
    [t.organizationId, brandId, `sib-${randomUUID()}`],
  );
  const sourceId = await one(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'ad_post', $4) RETURNING id`,
    [t.organizationId, brandId, connectionId, `sib-post-${randomUUID()}`],
  );
  return { ...t, brandId, connectionId, sourceId, otherSourceId: sourceId };
}

async function comments(t: Tenant, bodies: string[], start = T0): Promise<string[]> {
  const ids = await seedNegativeComments(h.c, t, { count: bodies.length, postedAt: start });
  for (const [i, id] of ids.entries()) {
    await h.c.query('UPDATE comment SET body = $2, posted_at = $3 WHERE id = $1', [
      id,
      bodies[i],
      new Date(start.getTime() + i * 60_000),
    ]);
  }
  return ids;
}

async function event(
  t: Tenant,
  type: AlertEventType | 'cap_reached',
  payload: AlertPayload | CapPayload,
): Promise<string> {
  const r = await h.c.query<{ id: string }>(
    `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, window_start, window_end, payload)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7) RETURNING id`,
    [
      t.organizationId,
      type === 'cap_reached' ? null : t.brandId,
      type,
      `k-${randomUUID()}`,
      T0,
      T1,
      payload,
    ],
  );
  return r.rows[0]!.id;
}

const spikePayload = (commentIds: string[], connectionIds: string[], connectionCount = 1) =>
  ({
    kind: 'spike',
    negatives: 12,
    total: 40,
    expectedPerHour: 2,
    trigger: 'volume',
    sensitivity: 'medium',
    minCount: 10,
    commentIds,
    connectionIds,
    connectionCount,
  }) satisfies AlertPayload;

const setMode = (t: Tenant, mode: 'excerpts' | 'counts_only') =>
  h.c.query(
    `INSERT INTO alert_brand_settings (organization_id, brand_id, content_mode) VALUES ($1, $2, $3)
     ON CONFLICT (brand_id) DO UPDATE SET content_mode = EXCLUDED.content_mode`,
    [t.organizationId, t.brandId, mode],
  );

describe('loadAlertView', () => {
  it('builds a spike view with brand timezone, accounts, counts and the spike link', async () => {
    await h.c.query("UPDATE connection SET display_name = 'Acme Page' WHERE id = $1", [
      a.connectionId,
    ]);
    const ids = await comments(a, ['first', 'second', 'third', 'fourth']);
    const id = await event(a, 'negative_spike', spikePayload(ids, [a.connectionId], 3));
    const v = await loadAlertView(pool, web, id, a.organizationId);
    expect(v).toEqual({
      type: 'negative_spike',
      organizationId: a.organizationId,
      workspaceName: 'Org a',
      brand: { id: a.brandId, name: 'Brand a', timezone: 'America/New_York' },
      accounts: [{ name: 'Acme Page', platform: 'facebook' }],
      moreAccounts: 2,
      window: { from: T0, to: T1 },
      counts: { negatives: 12, total: 40, expectedPerHour: 2 },
      excerpts: ['fourth', 'third', 'second'],
      link: spikeLink(web, a.organizationId, a.brandId, T0, T1),
    });
  });

  it("excerpts only from the event's brand: payload with an org B comment id yields no B text", async () => {
    const own = await comments(a, ['own text']);
    const other = await comments(b, ['ORG-B-SECRET'], T1);
    const sib = await comments(sibling, ['SIBLING-SECRET'], T1);
    const id = await event(
      a,
      'negative_spike',
      spikePayload([...other, ...sib, ...own], [b.connectionId, sibling.connectionId]),
    );
    const v = await loadAlertView(pool, web, id, a.organizationId);
    expect(v!.excerpts).toEqual(['own text']);
    expect(v!.accounts).toEqual([]);
    expect(JSON.stringify(v)).not.toMatch(/SECRET|Sibling IG|page-b/);
  });

  it("returns null for another organization's event", async () => {
    const id = await event(b, 'negative_spike', spikePayload([], []));
    expect(await loadAlertView(pool, web, id, a.organizationId)).toBeNull();
  });

  it('counts_only brand → excerpts empty even with ids', async () => {
    const ids = await comments(b, ['should not load']);
    await setMode(b, 'counts_only');
    try {
      const id = await event(b, 'negative_spike', spikePayload(ids, [b.connectionId]));
      const v = await loadAlertView(pool, web, id, b.organizationId);
      expect(v!.excerpts).toEqual([]);
      expect(v!.counts).toEqual({ negatives: 12, total: 40, expectedPerHour: 2 });
    } finally {
      await setMode(b, 'excerpts');
    }
  });

  it('deleted comment excluded', async () => {
    const ids = await comments(b, ['kept', 'gone']);
    await h.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [ids[1]]);
    const id = await event(b, 'negative_spike', spikePayload(ids, []));
    expect((await loadAlertView(pool, web, id, b.organizationId))!.excerpts).toEqual(['kept']);
  });

  it('carries the trigger count on escalations', async () => {
    const id = await event(b, 'spike_escalation', { ...spikePayload([], []), triggerCount: 12 });
    const v = await loadAlertView(pool, web, id, b.organizationId);
    expect(v!.type).toBe('spike_escalation');
    expect(v!.counts).toEqual({ negatives: 12, total: 40, expectedPerHour: 2, triggerCount: 12 });
  });

  it('flag digest: live count and newest three excerpts of open items, review link', async () => {
    const items = await seedFlags(h.c, b, { count: 4, createdAt: T0 });
    const r = await h.c.query<{ id: string; comment_id: string }>(
      'SELECT id, comment_id FROM review_item WHERE id = ANY($1::uuid[]) ORDER BY id',
      [items],
    );
    for (const [i, row] of r.rows.entries()) {
      await h.c.query('UPDATE comment SET body = $2, posted_at = $3 WHERE id = $1', [
        row.comment_id,
        `flag ${i}`,
        new Date(T0.getTime() + i * 60_000),
      ]);
    }
    await h.c.query(
      `UPDATE review_item SET status = 'resolved', resolution = 'dismissed', resolved_at = now()
        WHERE id = $1`,
      [r.rows[3]!.id],
    );
    const [otherItem] = await seedFlags(h.c, a, { count: 1, createdAt: T0 });
    const id = await event(b, 'flagged_digest', {
      kind: 'flags',
      reviewItemIds: [...items, otherItem!],
      count: 5,
    });
    const v = await loadAlertView(pool, web, id, b.organizationId);
    expect(v!.liveItemCount).toBe(3);
    expect(v!.counts).toEqual({ count: 5 });
    expect(v!.excerpts).toEqual(['flag 2', 'flag 1', 'flag 0']);
    expect(v!.accounts).toEqual([{ name: 'page-b', platform: 'facebook' }]);
    expect(v!.moreAccounts).toBe(0);
    expect(v!.link).toBe(reviewLink(web, b.organizationId, b.brandId));
  });

  it('cap view has no brand data and links the workspace alert settings', async () => {
    const id = await event(a, 'cap_reached', {
      kind: 'cap',
      cap: 20,
      resumesAt: '2026-10-17T11:05:00.000Z',
    });
    expect(await loadAlertView(pool, web, id, a.organizationId)).toEqual({
      type: 'cap_reached',
      organizationId: a.organizationId,
      workspaceName: 'Org a',
      brand: null,
      accounts: [],
      moreAccounts: 0,
      window: null,
      counts: { cap: 20, resumesAt: Date.parse('2026-10-17T11:05:00.000Z') },
      excerpts: [],
      link: settingsLink(web, a.organizationId),
    });
  });

  it('archived brand → null', async () => {
    const id = await event(sibling, 'negative_spike', spikePayload([], []));
    await h.c.query('UPDATE brand SET archived_at = now() WHERE id = $1', [sibling.brandId]);
    expect(await loadAlertView(pool, web, id, sibling.organizationId)).toBeNull();
  });
});
