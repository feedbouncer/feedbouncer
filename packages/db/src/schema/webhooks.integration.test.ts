import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { deleteOrganization } from '../organization-delete.js';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

const ALL_TYPES = ['comment.received', 'comment.hidden', 'item.flagged'];

const count = async (table: string, organizationId: string) =>
  Number(
    (
      await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1`,
        [organizationId],
      )
    ).rows[0]!.n,
  );

const events = async (t: Tenant) =>
  (
    await c.query<{ type: string }>(
      'SELECT type FROM webhook_event WHERE organization_id = $1 ORDER BY created_at, id',
      [t.organizationId],
    )
  ).rows.map((r) => r.type);

async function endpoint(
  t: Tenant,
  over: { eventTypes?: string[]; status?: string; url?: string } = {},
) {
  const disabled = over.status === 'disabled';
  return (
    await c.query<{ id: string }>(
      `INSERT INTO webhook_endpoint (organization_id, url, event_types, status, disabled_reason, disabled_at, signing_key_id, encrypted_signing_secret)
       VALUES ($1, $2, $3, $4, $5, $6, 'k1', '\\x0101'::bytea) RETURNING id`,
      [
        t.organizationId,
        over.url ?? 'https://example.test/hook',
        over.eventTypes ?? ALL_TYPES,
        over.status ?? 'active',
        disabled ? 'manual' : null,
        disabled ? new Date() : null,
      ],
    )
  ).rows[0]!.id;
}

async function comment(t: Tenant, over: Record<string, unknown> = {}, externalId = `c-${uuid()}`) {
  const row = { ingest_origin: 'live', is_own_account: false, ...over };
  const cols = Object.keys(row);
  return (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at, ${cols.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, 'hello', now(), ${cols.map((_, i) => `$${i + 7}`).join(', ')}) RETURNING id`,
      [
        t.organizationId,
        t.brandId,
        t.connectionId,
        t.sourceId,
        t.authorId,
        externalId,
        ...Object.values(row),
      ],
    )
  ).rows[0]!.id;
}

async function hideAction(t: Tenant, commentId: string, kind: string, status: string) {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, CASE WHEN $7 = 'pending' THEN NULL ELSE now() END) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, commentId, kind, `k:${uuid()}`, status],
    )
  ).rows[0]!.id;
}

const setStatus = (id: string, status: string) =>
  c.query(
    "UPDATE moderation_action SET status = $2, completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END WHERE id = $1",
    [id, status],
  );

describe('comment.received', () => {
  it('creates one event and one pending delivery per live comment, and none on conflict update', async () => {
    const t = await seedTenant(c, 'received');
    const ep = await endpoint(t);
    const externalId = `c-${uuid()}`;
    await comment(t, {}, externalId);
    expect(await events(t)).toEqual(['comment.received']);
    const deliveries = (
      await c.query(
        'SELECT endpoint_id, kind, status, attempts, next_attempt_at <= now() AS due FROM webhook_delivery WHERE organization_id = $1',
        [t.organizationId],
      )
    ).rows;
    expect(deliveries).toEqual([
      { endpoint_id: ep, kind: 'event', status: 'pending', attempts: 0, due: true },
    ]);
    await c.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'edited', now())
       ON CONFLICT (connection_id, external_id) DO UPDATE SET body = EXCLUDED.body`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId, externalId],
    );
    expect(await events(t)).toEqual(['comment.received']);
    expect(await count('webhook_delivery', t.organizationId)).toBe(1);
  });

  it('ignores backfill and own-account comments', async () => {
    const t = await seedTenant(c, 'received-skip');
    await endpoint(t);
    await comment(t, { ingest_origin: 'backfill' });
    await comment(t, { is_own_account: true });
    expect(await events(t)).toEqual([]);
  });
});

describe('comment.hidden', () => {
  it('fires once when a hide becomes applied', async () => {
    const t = await seedTenant(c, 'hidden');
    await endpoint(t, { eventTypes: ['comment.hidden'] });
    const id = await hideAction(
      t,
      await comment(t, { ingest_origin: 'backfill' }),
      'hide',
      'pending',
    );
    expect(await events(t)).toEqual([]);
    await setStatus(id, 'applied');
    expect(await events(t)).toEqual(['comment.hidden']);
    const ev = (
      await c.query(
        'SELECT dedupe_key, moderation_action_id, comment_id, brand_id FROM webhook_event WHERE organization_id = $1',
        [t.organizationId],
      )
    ).rows[0];
    expect(ev.dedupe_key).toBe(`comment.hidden:${id}`);
    expect(ev.moderation_action_id).toBe(id);
    expect(ev.brand_id).toBe(t.brandId);
    await setStatus(id, 'applied');
    expect(await events(t)).toEqual(['comment.hidden']);
  });

  it('ignores a hide inserted directly as noop', async () => {
    const t = await seedTenant(c, 'hidden-noop');
    await endpoint(t);
    await hideAction(t, await comment(t, { ingest_origin: 'backfill' }), 'hide', 'noop');
    expect(await events(t)).toEqual([]);
  });

  it('fires for each hide in a hide, unhide, hide sequence and never for unhide', async () => {
    const t = await seedTenant(c, 'hidden-seq');
    await endpoint(t, { eventTypes: ['comment.hidden'] });
    const commentId = await comment(t, { ingest_origin: 'backfill' });
    for (const kind of ['hide', 'unhide', 'hide']) {
      await setStatus(await hideAction(t, commentId, kind, 'pending'), 'applied');
    }
    expect(await events(t)).toEqual(['comment.hidden', 'comment.hidden']);
  });
});

describe('item.flagged', () => {
  it('creates one event per review item', async () => {
    const t = await seedTenant(c, 'flagged');
    await endpoint(t);
    await c.query(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       VALUES ($1, $2, $3, $4, 'user')`,
      [
        t.organizationId,
        t.brandId,
        t.connectionId,
        await comment(t, { ingest_origin: 'backfill' }),
      ],
    );
    expect(await events(t)).toEqual(['item.flagged']);
    expect(await count('webhook_delivery', t.organizationId)).toBe(1);
  });
});

describe('subscription and tenancy', () => {
  it('queues nothing for an endpoint not subscribed to the type', async () => {
    const t = await seedTenant(c, 'unsub');
    await endpoint(t, { eventTypes: ['item.flagged'] });
    await comment(t);
    expect(await events(t)).toEqual([]);
    expect(await count('webhook_delivery', t.organizationId)).toBe(0);
  });

  it('queues nothing for a disabled endpoint', async () => {
    const t = await seedTenant(c, 'disabled');
    await endpoint(t, { status: 'disabled' });
    await comment(t);
    expect(await count('webhook_event', t.organizationId)).toBe(0);
    expect(await count('webhook_delivery', t.organizationId)).toBe(0);
  });

  it('does not leak events across organizations', async () => {
    const a = await seedTenant(c, 'iso-a');
    const b = await seedTenant(c, 'iso-b');
    await endpoint(a);
    await comment(b);
    expect(await count('webhook_event', a.organizationId)).toBe(0);
    expect(await count('webhook_event', b.organizationId)).toBe(0);
    expect(await count('webhook_delivery', a.organizationId)).toBe(0);
  });

  it('rejects a delivery whose endpoint belongs to another organization', async () => {
    const a = await seedTenant(c, 'fk-a');
    const b = await seedTenant(c, 'fk-b');
    await endpoint(a);
    await comment(a);
    const eventId = (
      await c.query<{ id: string }>('SELECT id FROM webhook_event WHERE organization_id = $1', [
        a.organizationId,
      ])
    ).rows[0]!.id;
    await expectPgError(
      c.query(
        "INSERT INTO webhook_delivery (organization_id, endpoint_id, event_id, kind) VALUES ($1, $2, $3, 'event')",
        [a.organizationId, await endpoint(b), eventId],
      ),
      '23503',
    );
  });

  it('allows one event delivery per endpoint and event but several redeliveries', async () => {
    const t = await seedTenant(c, 'dup');
    await endpoint(t);
    await comment(t);
    const d = (
      await c.query<{ endpoint_id: string; event_id: string }>(
        'SELECT endpoint_id, event_id FROM webhook_delivery WHERE organization_id = $1',
        [t.organizationId],
      )
    ).rows[0]!;
    const insert = (kind: string) =>
      c.query(
        'INSERT INTO webhook_delivery (organization_id, endpoint_id, event_id, kind) VALUES ($1, $2, $3, $4)',
        [t.organizationId, d.endpoint_id, d.event_id, kind],
      );
    await expectPgError(insert('event'), '23505');
    await insert('redelivery');
    await insert('redelivery');
  });
});

describe('constraints', () => {
  it('validates endpoint url and event types', async () => {
    const t = await seedTenant(c, 'ep-check');
    await expectPgError(endpoint(t, { url: 'http://example.test/hook' }), '23514');
    await expectPgError(endpoint(t, { eventTypes: [] }), '23514');
    await expectPgError(endpoint(t, { eventTypes: ['comment.deleted'] }), '23514');
  });

  it('requires each event type to carry exactly its subject keys', async () => {
    const t = await seedTenant(c, 'ev-check');
    const insert = (type: string, commentId: string | null) =>
      c.query(
        `INSERT INTO webhook_event (organization_id, brand_id, type, dedupe_key, comment_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [t.organizationId, t.brandId, type, `k:${uuid()}`, commentId],
      );
    await expectPgError(insert('comment.received', null), '23514');
    await expectPgError(
      insert('item.flagged', await comment(t, { is_own_account: true })),
      '23514',
    );
    await insert('comment.received', await comment(t, { is_own_account: true }));
  });
});

describe('cascade', () => {
  it('cascades events and deliveries when the comment is deleted', async () => {
    const t = await seedTenant(c, 'cascade-comment');
    await endpoint(t);
    const id = await comment(t);
    expect(await count('webhook_delivery', t.organizationId)).toBe(1);
    await c.query('DELETE FROM comment WHERE id = $1', [id]);
    expect(await count('webhook_event', t.organizationId)).toBe(0);
    expect(await count('webhook_delivery', t.organizationId)).toBe(0);
  });

  it('cascades all three tables on deleteOrganization', async () => {
    const t = await seedTenant(c, 'cascade-org');
    await endpoint(t);
    await comment(t);
    await c.query("UPDATE connection SET status = 'revoked' WHERE organization_id = $1", [
      t.organizationId,
    ]);
    expect(await deleteOrganization(c, t.organizationId, 'Org cascade-org')).toBe('deleted');
    for (const table of ['webhook_endpoint', 'webhook_event', 'webhook_delivery']) {
      expect(await count(table, t.organizationId)).toBe(0);
    }
  });
});
