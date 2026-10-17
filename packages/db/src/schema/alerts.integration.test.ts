import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261017000200_alerts';
const TABLES = [
  'alert_channel',
  'alert_brand_settings',
  'alert_route',
  'alert_brand_state',
  'alert_negative_hourly',
  'alert_event',
  'alert_delivery',
  'alert_flag_item',
];

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0]!.id;
const count = async (table: string, where: string, v: unknown[]) =>
  Number(
    (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, v)).rows[0]!
      .n,
  );

const slack = (t: Tenant, over: Record<string, unknown> = {}) => {
  const row = {
    kind: 'slack',
    label: 'Alerts',
    status: 'active',
    key_id: 'k1',
    encrypted_webhook_url: Buffer.from('sealed'),
    webhook_hint: '...abcd',
    ...over,
  };
  const cols = Object.keys(row);
  return id(
    `INSERT INTO alert_channel (organization_id, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [t.organizationId, ...Object.values(row)],
  );
};
const email = (t: Tenant, over: Record<string, unknown> = {}) => {
  const row = {
    kind: 'email',
    label: 'Team',
    status: 'pending_confirmation',
    key_id: 'k1',
    email: 'team@example.test',
    unsubscribe_key_sha256: Buffer.from(uuid()),
    encrypted_unsubscribe_token: Buffer.from('sealed'),
    ...over,
  };
  const cols = Object.keys(row);
  return id(
    `INSERT INTO alert_channel (organization_id, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [t.organizationId, ...Object.values(row)],
  );
};
const event = (
  t: Tenant,
  key: string,
  type = 'negative_spike',
  brandId: string | null = t.brandId,
) =>
  id(
    `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
     VALUES ($1, $2, $3, $4, 'queued', '{}') RETURNING id`,
    [t.organizationId, brandId, type, key],
  );
const delivery = (t: Tenant, eventId: string, channelId: string) =>
  id(
    `INSERT INTO alert_delivery (organization_id, alert_event_id, channel_id, state)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [t.organizationId, eventId, channelId],
  );
const route = (t: Tenant, channelId: string) =>
  c.query(
    `INSERT INTO alert_route (organization_id, brand_id, alert_type, channel_id, enabled)
     VALUES ($1, $2, 'negative_spike', $3, false)`,
    [t.organizationId, t.brandId, channelId],
  );

describe('alert_channel', () => {
  it('slack channel requires sealed url and hint and only active/disconnected status; email channel requires lowercase email and sealed unsubscribe token', async () => {
    const t = await seedTenant(c, 'chan');
    await slack(t);
    await slack(t, { status: 'disconnected', disconnected_code: 'revoked' });
    await expectPgError(slack(t, { status: 'pending_confirmation' }), '23514');
    await expectPgError(slack(t, { status: 'unsubscribed' }), '23514');
    await expectPgError(slack(t, { encrypted_webhook_url: null }), '23514');
    await expectPgError(slack(t, { webhook_hint: null }), '23514');
    await expectPgError(slack(t, { key_id: null }), '23514');
    await expectPgError(slack(t, { email: 'a@example.test' }), '23514');
    await expectPgError(
      slack(t, {
        unsubscribe_key_sha256: Buffer.from('x'),
        encrypted_unsubscribe_token: Buffer.from('y'),
      }),
      '23514',
    );
    await expectPgError(slack(t, { label: ' x' }), '23514');
    await expectPgError(slack(t, { label: '' }), '23514');
    await expectPgError(slack(t, { label: 'a'.repeat(81) }), '23514');

    await email(t);
    await email(t, { email: 'b@example.test', status: 'active' });
    await email(t, { email: 'c@example.test', status: 'unsubscribed' });
    await expectPgError(email(t, { email: 'D@example.test' }), '23514');
    await expectPgError(email(t, { email: `${'a'.repeat(250)}@x.test` }), '23514');
    await expectPgError(email(t, { email: null }), '23514');
    await expectPgError(email(t, { unsubscribe_key_sha256: null }), '23514');
    await expectPgError(email(t, { encrypted_unsubscribe_token: null }), '23514');
    await expectPgError(email(t, { key_id: null }), '23514');
    await expectPgError(email(t, { status: 'disconnected' }), '23514');
    await expectPgError(email(t, { encrypted_webhook_url: Buffer.from('x') }), '23514');
    await expectPgError(email(t, { kind: 'sms' }), '23514');
  });

  it('email unique per org, not across orgs', async () => {
    const a = await seedTenant(c, 'em-a');
    const b = await seedTenant(c, 'em-b');
    await email(a);
    await expectPgError(email(a), '23505', 'alert_channel_organization_id_email_key');
    await email(b);
  });

  it('confirm and unsubscribe key hashes are globally unique', async () => {
    const a = await seedTenant(c, 'key-a');
    const hash = Buffer.from(uuid());
    await email(a, { confirm_key_sha256: hash, email: 'one@example.test' });
    await expectPgError(
      email(a, { confirm_key_sha256: hash, email: 'two@example.test' }),
      '23505',
      'alert_channel_confirm_key_sha256_key',
    );
    const un = Buffer.from(uuid());
    await email(a, { unsubscribe_key_sha256: un, email: 'three@example.test' });
    await expectPgError(
      email(a, { unsubscribe_key_sha256: un, email: 'four@example.test' }),
      '23505',
      'alert_channel_unsubscribe_key_sha256_key',
    );
  });
});

describe('alert_route', () => {
  it('route cannot link org A brand to org B channel', async () => {
    const a = await seedTenant(c, 'rt-a');
    const b = await seedTenant(c, 'rt-b');
    const chB = await slack(b);
    await expectPgError(route(a, chB), '23503', 'alert_route_channel_id_fkey');
    await route(b, chB);
  });

  it('enabled requires enabled_at', async () => {
    const t = await seedTenant(c, 'rt-en');
    const ch = await slack(t);
    await expectPgError(
      c.query(
        `INSERT INTO alert_route (organization_id, brand_id, alert_type, channel_id, enabled)
         VALUES ($1, $2, 'flagged_item', $3, true)`,
        [t.organizationId, t.brandId, ch],
      ),
      '23514',
    );
  });
});

describe('alert_event', () => {
  it('alert_event key unique per org; cap_reached requires null brand', async () => {
    const a = await seedTenant(c, 'ev-a');
    const b = await seedTenant(c, 'ev-b');
    await event(a, 'k1');
    await expectPgError(event(a, 'k1'), '23505', 'alert_event_organization_id_alert_key_key');
    await event(b, 'k1');
    await expectPgError(event(a, 'cap', 'cap_reached'), '23514');
    await expectPgError(event(a, 'k2', 'negative_spike', null), '23514');
    await event(a, 'cap', 'cap_reached', null);
    await expectPgError(event(a, 'k3', 'bogus'), '23514');
    await expectPgError(event(a, ''), '23514');
    await expectPgError(
      c.query(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', 'arr', 'queued', '[]')`,
        [a.organizationId, a.brandId],
      ),
      '23514',
    );
    await expectPgError(
      c.query(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', 'big', 'queued', jsonb_build_object('x', repeat('a', 17000)))`,
        [a.organizationId, a.brandId],
      ),
      '23514',
    );
  });
});

describe('alert_delivery', () => {
  it('delivery unique per (event, channel)', async () => {
    const t = await seedTenant(c, 'dl');
    const ev = await event(t, 'e1');
    const ch = await slack(t);
    await delivery(t, ev, ch);
    await expectPgError(
      delivery(t, ev, ch),
      '23505',
      'alert_delivery_alert_event_id_channel_id_key',
    );
  });

  it('cannot reference another organization event or channel; attempts bounded', async () => {
    const a = await seedTenant(c, 'dl-a');
    const b = await seedTenant(c, 'dl-b');
    const evB = await event(b, 'e1');
    const chA = await slack(a);
    await expectPgError(delivery(a, evB, chA), '23503');
    const evA = await event(a, 'e1');
    const chB = await slack(b);
    await expectPgError(delivery(a, evA, chB), '23503');
    await expectPgError(
      c.query('UPDATE alert_delivery SET attempts = 7 WHERE id = $1', [
        await delivery(a, evA, chA),
      ]),
      '23514',
    );
  });
});

describe('alert_flag_item', () => {
  const reviewItem = async (t: Tenant) => {
    const commentId = await id(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1, $2, $3, $4, $5, 'text', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
    );
    const reviewId = await id(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       VALUES ($1, $2, $3, $4, 'user') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, commentId],
    );
    return { commentId, reviewId };
  };
  const flag = (t: Tenant, r: { commentId: string; reviewId: string }) =>
    c.query(
      `INSERT INTO alert_flag_item (organization_id, brand_id, review_item_id, comment_id, flagged_at, state)
       VALUES ($1, $2, $3, $4, now(), 'pending')`,
      [t.organizationId, t.brandId, r.reviewId, r.commentId],
    );

  it('flag item unique per review_item; cascades when review_item is deleted', async () => {
    const t = await seedTenant(c, 'flag');
    const r = await reviewItem(t);
    await flag(t, r);
    await expectPgError(flag(t, r), '23505', 'alert_flag_item_pkey');
    await c.query('DELETE FROM review_item WHERE id = $1', [r.reviewId]);
    expect(await count('alert_flag_item', 'organization_id = $1', [t.organizationId])).toBe(0);
  });
});

describe('cascades', () => {
  const fill = async (t: Tenant) => {
    const ch = await slack(t);
    const ev = await event(t, 'e1');
    await delivery(t, ev, ch);
    await route(t, ch);
    await c.query('INSERT INTO alert_brand_settings (organization_id, brand_id) VALUES ($1, $2)', [
      t.organizationId,
      t.brandId,
    ]);
    await c.query('INSERT INTO alert_brand_state (organization_id, brand_id) VALUES ($1, $2)', [
      t.organizationId,
      t.brandId,
    ]);
    await c.query(
      `INSERT INTO alert_negative_hourly (organization_id, brand_id, hour, negatives, total)
       VALUES ($1, $2, date_trunc('hour', now()), 1, 2)`,
      [t.organizationId, t.brandId],
    );
  };
  const brandTables = [
    'alert_brand_settings',
    'alert_route',
    'alert_brand_state',
    'alert_negative_hourly',
    'alert_event',
  ];

  it('deleting a brand row or the organization cascades every alert table', async () => {
    const a = await seedTenant(c, 'cas-a');
    await fill(a);
    await c.query('DELETE FROM brand WHERE id = $1', [a.brandId]);
    for (const tbl of brandTables)
      expect(await count(tbl, 'organization_id = $1', [a.organizationId]), tbl).toBe(0);
    // The channel is organization-level and survives the brand; its deliveries went with the event.
    expect(await count('alert_channel', 'organization_id = $1', [a.organizationId])).toBe(1);
    expect(await count('alert_delivery', 'organization_id = $1', [a.organizationId])).toBe(0);

    const b = await seedTenant(c, 'cas-b');
    await fill(b);
    await event(b, 'cap', 'cap_reached', null);
    await c.query('DELETE FROM organization WHERE id = $1', [b.organizationId]);
    for (const tbl of TABLES)
      expect(await count(tbl, 'organization_id = $1', [b.organizationId]), tbl).toBe(0);
  });
});

describe('error code columns', () => {
  it("reject 'Bad Code!'", async () => {
    const t = await seedTenant(c, 'codes');
    await expectPgError(slack(t, { last_failure_code: 'Bad Code!' }), '23514');
    await slack(t, { last_failure_code: 'http_500' });
    const ev = await event(t, 'e1');
    const ch = await slack(t);
    const d = await delivery(t, ev, ch);
    await expectPgError(
      c.query("UPDATE alert_delivery SET last_error_code = 'Bad Code!' WHERE id = $1", [d]),
      '23514',
    );
  });
});

describe('down.sql', () => {
  it('reverts cleanly', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const applied = await snapshotSchema(k);
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        // Migrations added after this one are rolled back first.
        for (const later of dirs.slice(dirs.indexOf(MIGRATION) + 1).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: later,
          });
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        for (const table of TABLES) expect(down).not.toMatch(new RegExp(`\\b${table}\\.`));
        expect(down).not.toMatch(/comment_organization_id_brand_id_posted_at_live_idx/);
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        expect(await snapshotSchema(k)).toEqual(applied);
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });
});
