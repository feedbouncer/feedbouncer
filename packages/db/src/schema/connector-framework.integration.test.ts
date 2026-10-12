import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'a');
  b = await seedTenant(ctx.c, 'b');
});
afterAll(() => ctx.close());

const envelopeLike = () => Buffer.concat([Buffer.from([1]), randomBytes(63)]);
const insert = (t: Tenant, over: Record<string, unknown> = {}) => {
  const row = {
    id: uuid(),
    organization_id: t.organizationId,
    brand_id: t.brandId,
    platform: 'facebook',
    initiated_by_user_id: t.userId,
    reconnect_connection_id: null,
    state_hash: randomBytes(32),
    encrypted_pkce_verifier: envelopeLike(),
    redirect_uri: 'https://app.test/cb',
    scopes: ['comments'],
    expires_at: new Date(Date.now() + 600_000),
    ...over,
  };
  return ctx.c.query(
    `INSERT INTO oauth_state (id, organization_id, brand_id, platform, initiated_by_user_id, reconnect_connection_id,
       state_hash, encrypted_pkce_verifier, redirect_uri, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    Object.values(row),
  );
};

describe('oauth_state', () => {
  it('accepts a well-formed row', async () => {
    await expect(insert(a)).resolves.toBeDefined();
  });
  it('state_hash is unique and exactly 32 bytes', async () => {
    const h = randomBytes(32);
    await insert(a, { state_hash: h });
    await expectPgError(insert(a, { state_hash: h }), '23505');
    await expectPgError(insert(a, { state_hash: randomBytes(31) }), '23514');
  });
  it('rejects plaintext in encrypted_pkce_verifier', async () => {
    await expectPgError(
      insert(a, {
        encrypted_pkce_verifier: Buffer.from('plain-verifier-value-plain-verifier-value'),
      }),
      '23514',
    );
  });
  it('caps lifetime at one hour', async () => {
    await expectPgError(insert(a, { expires_at: new Date(Date.now() + 2 * 3_600_000) }), '23514');
  });
  it('cannot point at another tenant brand or connection', async () => {
    await expectPgError(insert(a, { brand_id: b.brandId }), '23503');
    await expectPgError(insert(a, { reconnect_connection_id: b.connectionId }), '23503');
  });
  // A sole owner cannot be deleted (last-owner guard), so use a separate initiator.
  it('is removed with its initiating user', async () => {
    const t = await seedTenant(ctx.c, 'gone-user');
    const u = await ctx.c.query('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
      `initiator-${uuid()}@example.test`,
    ]);
    await insert(t, { initiated_by_user_id: u.rows[0].id });
    await ctx.c.query('DELETE FROM app_user WHERE id = $1', [u.rows[0].id]);
    const left = await ctx.c.query('SELECT 1 FROM oauth_state WHERE brand_id = $1', [t.brandId]);
    expect(left.rowCount).toBe(0);
  });
  it('is removed with its brand', async () => {
    const t = await seedTenant(ctx.c, 'gone-brand');
    await insert(t);
    await ctx.c.query('DELETE FROM brand WHERE id = $1', [t.brandId]);
    const left = await ctx.c.query('SELECT 1 FROM oauth_state WHERE brand_id = $1', [t.brandId]);
    expect(left.rowCount).toBe(0);
  });
  it('is removed with the connection it reconnects', async () => {
    const t = await seedTenant(ctx.c, 'gone-conn');
    await insert(t, { reconnect_connection_id: t.connectionId });
    await ctx.c.query('DELETE FROM connection WHERE id = $1', [t.connectionId]);
    const left = await ctx.c.query('SELECT 1 FROM oauth_state WHERE brand_id = $1', [t.brandId]);
    expect(left.rowCount).toBe(0);
  });
});

describe('connection.granted_scopes', () => {
  it('defaults to empty and rejects NULL elements', async () => {
    const r = await ctx.c.query('SELECT granted_scopes FROM connection WHERE id = $1', [
      a.connectionId,
    ]);
    expect(r.rows[0].granted_scopes).toEqual([]);
    await expectPgError(
      ctx.c.query("UPDATE connection SET granted_scopes = ARRAY['a', NULL] WHERE id = $1", [
        a.connectionId,
      ]),
      '23514',
    );
  });
});
