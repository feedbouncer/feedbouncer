import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { Secret } from '@feedbouncer/service-runtime';
import {
  CredentialStore,
  markReconnectRequired,
  type ConnectionScope,
} from './credential-store.js';
import { ConnectionNotFoundError, CredentialUnreadableError } from './errors.js';
import { testKeyring } from './testing.js';

const ACCESS = 'EAAGsentinelAccess-4f1d2c9b8a7e6d5c';
const REFRESH = 'sentinelRefresh-0a9b8c7d6e5f4a3b2c1d';
let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
const keys = testKeyring(['k1']);
let store: CredentialStore;
const scopeOf = (t: Tenant): ConnectionScope => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId: t.connectionId,
});

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'secrets-test', onIdleError: () => {} });
  a = await seedTenant(h.c, 'a');
  b = await seedTenant(h.c, 'b');
  store = new CredentialStore(pool, keys);
  await store.put(scopeOf(a), 'access_token', new Secret(ACCESS), new Date('2030-01-01T00:00:00Z'));
  await store.put(scopeOf(a), 'refresh_token', new Secret(REFRESH));
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

describe('CredentialStore', () => {
  it('round-trips as a Secret with expiry', async () => {
    const c = await store.get(scopeOf(a), 'access_token');
    expect(c!.value).toBeInstanceOf(Secret);
    expect(c!.value.reveal()).toBe(ACCESS);
    expect(c!.expiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('upserts: one row per (connection, kind), newest value wins', async () => {
    const t = await seedTenant(h.c, 'upsert');
    await store.put(scopeOf(t), 'access_token', new Secret('first-value-000000000'));
    await store.put(scopeOf(t), 'access_token', new Secret('second-value-11111111'));
    expect((await store.get(scopeOf(t), 'access_token'))!.value.reveal()).toBe(
      'second-value-11111111',
    );
    const { rows } = await h.c.query(
      'SELECT count(*)::int AS n FROM connection_secret WHERE connection_id = $1',
      [t.connectionId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('isolates tenants on read and write', async () => {
    const mixed = { ...scopeOf(b), connectionId: a.connectionId };
    expect(await store.get(mixed, 'access_token')).toBeNull();
    await expect(
      store.put(mixed, 'access_token', new Secret('attacker-value-123456')),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect((await store.get(scopeOf(a), 'access_token'))!.value.reveal()).toBe(ACCESS);
  });

  it("detects a ciphertext copied onto another tenant's connection", async () => {
    await store.put(scopeOf(b), 'access_token', new Secret('b-own-token-9999999999'));
    await h.c.query(
      `UPDATE connection_secret dst SET key_id = src.key_id, encrypted_value = src.encrypted_value
         FROM connection_secret src
        WHERE src.connection_id = $1 AND src.kind = 'access_token'
          AND dst.connection_id = $2 AND dst.kind = 'access_token'`,
      [a.connectionId, b.connectionId],
    );
    await expect(store.get(scopeOf(b), 'access_token')).rejects.toMatchObject({
      reason: 'tampered',
    });
  });

  it('reads fresh from the database every time (no plaintext cache)', async () => {
    const t = await seedTenant(h.c, 'nocache');
    await store.put(scopeOf(t), 'webhook_secret', new Secret('wh-secret-one-000000'));
    const seen: string[] = [];
    await store.withCredentials(
      scopeOf(t),
      ['webhook_secret'],
      async (m) => void seen.push(m.get('webhook_secret')!.value.reveal()),
    );
    await store.put(scopeOf(t), 'webhook_secret', new Secret('wh-secret-two-000000'));
    await store.withCredentials(
      scopeOf(t),
      ['webhook_secret'],
      async (m) => void seen.push(m.get('webhook_secret')!.value.reveal()),
    );
    expect(seen).toEqual(['wh-secret-one-000000', 'wh-secret-two-000000']);
  });

  it('fails safely with unknown_key when the writing key is not configured', async () => {
    const other = new CredentialStore(pool, testKeyring(['k9']));
    const err = await other.get(scopeOf(a), 'access_token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialUnreadableError);
    expect(err).toMatchObject({ reason: 'unknown_key', keyId: 'k1' });
    expect((err as Error).message).not.toContain(ACCESS);
  });

  it('rejects empty values at Secret construction (nothing sealable)', () => {
    expect(() => new Secret('')).toThrow(TypeError);
  });

  it('rejects unknown credential kinds before touching the database', async () => {
    const t = await seedTenant(h.c, 'badkind');
    await expect(
      store.put(scopeOf(t), 'password' as never, new Secret('x-value-123456789')),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(store.get(scopeOf(t), 'password' as never)).rejects.toBeInstanceOf(TypeError);
    await expect(store.delete(scopeOf(t), 'password' as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('withCredentials returns only the stored kinds', async () => {
    const t = await seedTenant(h.c, 'multi');
    await store.put(scopeOf(t), 'access_token', new Secret('multi-access-0000000'));
    await store.withCredentials(scopeOf(t), ['access_token', 'refresh_token'], async (m) => {
      expect([...m.keys()]).toEqual(['access_token']);
    });
  });

  it('delete is scoped: another tenant cannot delete, the owner can (one kind or all)', async () => {
    const t = await seedTenant(h.c, 'del');
    await store.put(scopeOf(t), 'access_token', new Secret('del-access-00000000'));
    await store.put(scopeOf(t), 'refresh_token', new Secret('del-refresh-0000000'));
    const mixed = { ...scopeOf(b), connectionId: t.connectionId };
    expect(await store.delete(mixed)).toBe(0);
    expect(await store.delete(mixed, 'access_token')).toBe(0);
    expect(await store.delete(scopeOf(t), 'access_token')).toBe(1);
    expect(await store.get(scopeOf(t), 'access_token')).toBeNull();
    expect(await store.delete(scopeOf(t))).toBe(1);
    expect(await store.get(scopeOf(t), 'refresh_token')).toBeNull();
  });

  it('leaves no plaintext anywhere in the database (dump check)', async () => {
    const { rows: tables } = await h.c.query<{ t: string }>(
      "SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'",
    );
    const needles = [ACCESS, REFRESH].flatMap((s) => [
      s,
      Buffer.from(s).toString('hex'),
      Buffer.from(s).toString('base64'),
    ]);
    for (const { t } of tables) {
      const { rows } = await h.c.query<{ r: string }>(`SELECT x::text AS r FROM ${t} x`);
      for (const { r } of rows) for (const n of needles) expect(r, `${t}`).not.toContain(n);
    }
  });
});

describe('markReconnectRequired', () => {
  it('flags once, records one audit event with reason and key id, and is idempotent', async () => {
    const t = await seedTenant(h.c, 'flag');
    const err = new CredentialUnreadableError('unknown_key', 'k0');
    expect(await markReconnectRequired(pool, scopeOf(t), err)).toBe(true);
    expect(await markReconnectRequired(pool, scopeOf(t), err)).toBe(false);
    const { rows: conn } = await h.c.query(
      'SELECT status, status_reason FROM connection WHERE id = $1',
      [t.connectionId],
    );
    expect(conn[0]).toEqual({
      status: 'reconnect_required',
      status_reason: 'credential_unknown_key',
    });
    const { rows: audit } = await h.c.query(
      "SELECT actor_type, details FROM audit_event WHERE subject_id = $1 AND action = 'connection.reconnect_required'",
      [t.connectionId],
    );
    expect(audit).toEqual([
      { actor_type: 'system', details: { reason: 'unknown_key', keyId: 'k0' } },
    ]);
  });

  it('does nothing for a scope that does not own the connection', async () => {
    const mixed = { ...scopeOf(b), connectionId: a.connectionId };
    expect(
      await markReconnectRequired(pool, mixed, new CredentialUnreadableError('tampered', 'k1')),
    ).toBe(false);
    const { rows } = await h.c.query('SELECT status FROM connection WHERE id = $1', [
      a.connectionId,
    ]);
    expect(rows[0].status).not.toBe('reconnect_required');
  });
});
