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

const count = async (table: string, organizationId: string) =>
  Number(
    (
      await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1`,
        [organizationId],
      )
    ).rows[0]!.n,
  );

const publicId = () =>
  [...uuid().replaceAll('-', '').slice(0, 16)]
    .map((ch) => 'abcdefghijklmnop'[parseInt(ch, 16)])
    .join('');

async function apiKey(t: Tenant, name = `key-${uuid()}`, over: Record<string, unknown> = {}) {
  const row = { name, public_id: publicId(), scope: 'read', ...over };
  const cols = Object.keys(row);
  return (
    await c.query<{ id: string }>(
      `INSERT INTO api_key (organization_id, secret_sha256, ${cols.join(', ')})
       VALUES ($1, decode(repeat('ab', 32), 'hex'), ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [t.organizationId, ...Object.values(row)],
    )
  ).rows[0]!.id;
}

async function comment(t: Tenant) {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'hello', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId, `c-${uuid()}`],
    )
  ).rows[0]!.id;
}

async function action(t: Tenant, actorType: string, actorApiKeyId: string | null) {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, actor_api_key_id, request_key, status)
       VALUES ($1, $2, $3, $4, 'hide', $5, $6, $7, 'pending') RETURNING id`,
      [
        t.organizationId,
        t.brandId,
        t.connectionId,
        await comment(t),
        actorType,
        actorApiKeyId,
        `k:${uuid()}`,
      ],
    )
  ).rows[0]!.id;
}

describe('api_key', () => {
  it('rejects a second active key with the same name, case-insensitively', async () => {
    const t = await seedTenant(c, 'name-a');
    await apiKey(t, 'CI');
    await expectPgError(apiKey(t, 'ci'), '23505', 'api_key_active_name_key');
    await apiKey(await seedTenant(c, 'name-b'), 'ci');
  });

  it('allows reusing a name after the first key is revoked', async () => {
    const t = await seedTenant(c, 'revoked');
    const first = await apiKey(t, 'CI');
    await c.query('UPDATE api_key SET revoked_at = now() WHERE id = $1', [first]);
    await apiKey(t, 'ci');
  });
});

describe('moderation_action actor', () => {
  it('rejects a non-api_key actor that carries actor_api_key_id', async () => {
    const t = await seedTenant(c, 'actor-check');
    await expectPgError(
      action(t, 'user', await apiKey(t)),
      '23514',
      'moderation_action_api_key_actor_check',
    );
  });

  it('accepts actor_type api_key with a key of the same org and rejects a key of another org', async () => {
    const a = await seedTenant(c, 'actor-a');
    const b = await seedTenant(c, 'actor-b');
    await action(a, 'api_key', await apiKey(a));
    await expectPgError(action(a, 'api_key', await apiKey(b)), '23503');
  });

  it('sets actor_api_key_id to NULL and keeps organization_id when the key row is deleted', async () => {
    const t = await seedTenant(c, 'actor-null');
    const key = await apiKey(t);
    const id = await action(t, 'api_key', key);
    await c.query('DELETE FROM api_key WHERE id = $1', [key]);
    const row = (
      await c.query(
        'SELECT organization_id, actor_api_key_id FROM moderation_action WHERE id = $1',
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ organization_id: t.organizationId, actor_api_key_id: null });
  });

  it('audit_event accepts api_key', async () => {
    const t = await seedTenant(c, 'audit');
    await c.query(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, details)
       VALUES ($1, $2, 'api_key', 'comment.moderated', 'comment', $3, '{}'::jsonb)`,
      [t.organizationId, t.brandId, await comment(t)],
    );
  });
});

describe('api_idempotency_record', () => {
  const record = (t: Tenant, keyId: string, over: Record<string, unknown> = {}) => {
    const row = {
      idempotency_key: 'req-1',
      state: 'in_progress',
      expires_at: new Date(Date.now() + 86_400_000),
      ...over,
    };
    const cols = Object.keys(row);
    return c.query(
      `INSERT INTO api_idempotency_record (organization_id, api_key_id, request_sha256, ${cols.join(', ')})
       VALUES ($1, $2, decode(repeat('cd', 32), 'hex'), ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
      [t.organizationId, keyId, ...Object.values(row)],
    );
  };

  it('is unique per key and independent across keys', async () => {
    const t = await seedTenant(c, 'idem');
    const k1 = await apiKey(t);
    const k2 = await apiKey(t);
    await record(t, k1);
    await record(t, k2);
    await expectPgError(
      record(t, k1),
      '23505',
      'api_idempotency_record_api_key_id_idempotency_key_key',
    );
  });

  it('validates key format, state and a key from the same org', async () => {
    const a = await seedTenant(c, 'idem-a');
    const b = await seedTenant(c, 'idem-b');
    const k = await apiKey(a);
    await expectPgError(record(a, k, { idempotency_key: 'bad key!' }), '23514');
    await expectPgError(record(a, k, { state: 'done' }), '23514');
    await expectPgError(record(b, k), '23503');
  });
});

describe('cascade', () => {
  it('cascades api_key and api_idempotency_record on deleteOrganization', async () => {
    const t = await seedTenant(c, 'cascade');
    const key = await apiKey(t);
    await c.query(
      `INSERT INTO api_idempotency_record (organization_id, api_key_id, idempotency_key, request_sha256, state, expires_at)
       VALUES ($1, $2, 'k', decode(repeat('cd', 32), 'hex'), 'in_progress', now() + interval '1 day')`,
      [t.organizationId, key],
    );
    await c.query("UPDATE connection SET status = 'revoked' WHERE organization_id = $1", [
      t.organizationId,
    ]);
    expect(await deleteOrganization(c, t.organizationId, 'Org cascade')).toBe('deleted');
    expect(await count('api_key', t.organizationId)).toBe(0);
    expect(await count('api_idempotency_record', t.organizationId)).toBe(0);
  });
});
