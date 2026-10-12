import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { PendingAuthorization, StateBinding } from '../ports.js';
import {
  PgConnectionDirectory,
  PgCredentialVault,
  PgDeliveryLedger,
  PgMembershipReader,
  PgOAuthStateStore,
  PgRefreshLock,
  PgWebhookSecrets,
} from './index.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
const keys = testKeyring(['k1']);
let store: CredentialStore;
let dir: PgConnectionDirectory;
let vault: PgCredentialVault;
let states: PgOAuthStateStore;
let members: PgMembershipReader;
let hooks: PgWebhookSecrets;
let ledger: PgDeliveryLedger;
const lines: string[] = [];
const log = createLogger('pg-adapters-test', 'debug', (l) => lines.push(l));

const scopeOf = (t: Tenant): ConnectionScope => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId: t.connectionId,
});
const bindingOf = (t: Tenant): StateBinding => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  platform: 'facebook',
  initiatedByUserId: t.userId,
});
const pending = (t: Tenant, verifier = 'verifier-a'): PendingAuthorization => ({
  id: randomUUID(),
  organizationId: t.organizationId,
  brandId: t.brandId,
  platform: 'facebook',
  initiatedByUserId: t.userId,
  redirectUri: 'https://app.feedbouncer.test/oauth/callback',
  scopes: ['read', 'moderate'],
  reconnectConnectionId: null,
  codeVerifier: new Secret(verifier),
  expiresAt: new Date(Date.now() + 600_000),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (id: string) =>
  (await h.c.query('SELECT status FROM connection WHERE id = $1', [id])).rows[0].status as string;
const stateRows = async () =>
  (await h.c.query('SELECT count(*)::int AS n FROM oauth_state')).rows[0].n as number;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'connectors-pg-test', onIdleError: () => {} });
  a = await seedTenant(h.c, 'a');
  b = await seedTenant(h.c, 'b');
  store = new CredentialStore(pool, keys);
  dir = new PgConnectionDirectory(pool);
  vault = new PgCredentialVault(store, pool, log);
  states = new PgOAuthStateStore(pool, keys);
  members = new PgMembershipReader(pool);
  hooks = new PgWebhookSecrets(pool, store, new Map([['facebook', new Secret('app-secret-fb')]]));
  ledger = new PgDeliveryLedger(pool, 'worker-test');
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

describe('tenant isolation (every adapter)', () => {
  it('PgConnectionDirectory.load returns null for a scope mixing tenants', async () => {
    expect(await dir.load(scopeOf(a))).toMatchObject({ platform: 'facebook', status: 'active' });
    expect(await dir.load({ ...scopeOf(a), organizationId: b.organizationId })).toBeNull();
    expect(await dir.load({ ...scopeOf(a), brandId: b.brandId })).toBeNull();
    expect(await dir.load({ ...scopeOf(a), connectionId: randomUUID() })).toBeNull();
  });

  it('PgConnectionDirectory.markReauthRequired cannot flag another tenant', async () => {
    expect(
      await dir.markReauthRequired(
        { ...scopeOf(b), organizationId: a.organizationId },
        'oauth_refresh_rejected',
      ),
    ).toBe(false);
    expect(
      await dir.markReauthRequired({ ...scopeOf(b), brandId: a.brandId }, 'oauth_refresh_rejected'),
    ).toBe(false);
    expect((await dir.load(scopeOf(b)))?.status).toBe('active');
  });

  it('PgConnectionDirectory.activate cannot touch another tenant', async () => {
    const t = await seedTenant(h.c, 'activate-iso');
    await h.c.query("UPDATE connection SET status = 'error' WHERE id = $1", [t.connectionId]);
    expect(await dir.activate({ ...scopeOf(t), organizationId: b.organizationId }, b.userId)).toBe(
      false,
    );
    expect(await dir.activate({ ...scopeOf(t), brandId: b.brandId }, b.userId)).toBe(false);
    expect(await statusOf(t.connectionId)).toBe('error');
  });

  it('PgConnectionDirectory.upsertPending cannot attach a connection to another tenant brand', async () => {
    await expect(
      dir.upsertPending({
        organizationId: b.organizationId,
        brandId: a.brandId,
        platform: 'facebook',
        externalAccountId: 'page-a',
        displayName: null,
        grantedScopes: [],
      }),
    ).rejects.toThrow();
    // the same external account under a's brand but with b's organization must not update a's row
    const before = await h.c.query('SELECT display_name FROM connection WHERE id = $1', [
      a.connectionId,
    ]);
    expect(before.rows[0].display_name).toBeNull();
  });

  it('PgCredentialVault reads nothing across tenants', async () => {
    await vault.writeAccessToken(scopeOf(a), {
      value: new Secret('tenant-a-access'),
      expiresAt: null,
    });
    expect(
      (await vault.readTokens({ ...scopeOf(a), organizationId: b.organizationId })).access,
    ).toBeNull();
    expect((await vault.readTokens({ ...scopeOf(a), brandId: b.brandId })).access).toBeNull();
    expect((await vault.readTokens(scopeOf(a))).access?.value.reveal()).toBe('tenant-a-access');
  });

  it('PgCredentialVault writes nothing across tenants', async () => {
    const mixed = { ...scopeOf(b), connectionId: a.connectionId };
    await expect(
      vault.writeAccessToken(mixed, { value: new Secret('attacker-access'), expiresAt: null }),
    ).rejects.toThrow();
    await expect(
      vault.writeRefreshToken(mixed, { value: new Secret('attacker-refresh'), expiresAt: null }),
    ).rejects.toThrow();
    expect((await vault.readTokens(scopeOf(a))).access?.value.reveal()).toBe('tenant-a-access');
    expect((await vault.readTokens(scopeOf(a))).refresh).toBeNull();
  });

  it('PgOAuthStateStore.consume requires the full binding and is single-use under concurrency', async () => {
    const hash = randomBytes(32);
    await states.save(hash, pending(a));
    expect(await states.consume(hash, { ...bindingOf(a), initiatedByUserId: b.userId })).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => states.consume(hash, bindingOf(a))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)!.codeVerifier.reveal()).toBe('verifier-a');
  });

  it('PgOAuthStateStore.consume with any mismatched binding field deletes nothing', async () => {
    const hash = randomBytes(32);
    await states.save(hash, pending(a));
    const before = await stateRows();
    for (const bad of [
      { ...bindingOf(a), organizationId: b.organizationId },
      { ...bindingOf(a), brandId: b.brandId },
      { ...bindingOf(a), platform: 'youtube' as const },
      { ...bindingOf(a), initiatedByUserId: b.userId },
    ])
      expect(await states.consume(hash, bad)).toBeNull();
    expect(await stateRows()).toBe(before);
    expect(await states.consume(hash, bindingOf(a))).not.toBeNull();
    expect(await stateRows()).toBe(before - 1);
  });

  it('PgOAuthStateStore never stores the verifier or state in plaintext', async () => {
    const hash = randomBytes(32);
    await states.save(hash, pending(a));
    const raw = await h.c.query(
      "SELECT encode(encrypted_pkce_verifier, 'escape') AS v, encode(state_hash, 'hex') AS s FROM oauth_state WHERE state_hash = $1",
      [hash],
    );
    expect(raw.rows[0].v).not.toContain('verifier-a');
    expect(raw.rows[0].s).toBe(hash.toString('hex'));
  });

  it('PgOAuthStateStore binds the sealed verifier to its row (a copied blob does not open)', async () => {
    const h1 = randomBytes(32);
    const h2 = randomBytes(32);
    await states.save(h1, pending(a, 'verifier-one'));
    await states.save(h2, pending(a, 'verifier-two'));
    await h.c.query(
      `UPDATE oauth_state dst SET encrypted_pkce_verifier = src.encrypted_pkce_verifier
         FROM oauth_state src WHERE src.state_hash = $1 AND dst.state_hash = $2`,
      [h1, h2],
    );
    expect(await states.consume(h2, bindingOf(a))).toBeNull();
    expect((await states.consume(h1, bindingOf(a)))?.codeVerifier.reveal()).toBe('verifier-one');
  });

  it('PgOAuthStateStore fails closed when the sealing key is no longer configured', async () => {
    const hash = randomBytes(32);
    await states.save(hash, pending(a));
    const rotated = new PgOAuthStateStore(pool, testKeyring(['k9']));
    expect(await rotated.consume(hash, bindingOf(a))).toBeNull();
    expect(await states.consume(hash, bindingOf(a))).toBeNull(); // consumed either way
  });

  it('PgOAuthStateStore.save removes expired rows and keeps live ones', async () => {
    const live = randomBytes(32);
    const old = randomBytes(32);
    await states.save(live, pending(a));
    await states.save(old, pending(a));
    await h.c.query(
      `UPDATE oauth_state SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '90 minutes' WHERE state_hash = $1`,
      [old],
    );
    await states.save(randomBytes(32), pending(a));
    const expired = await h.c.query('SELECT 1 FROM oauth_state WHERE state_hash = $1', [old]);
    expect(expired.rowCount).toBe(0);
    expect(await states.consume(old, bindingOf(a))).toBeNull();
    expect(await states.consume(live, bindingOf(a))).not.toBeNull();
  });

  it('PgMembershipReader requires the brand to belong to the organization', async () => {
    expect(await members.roleInBrand(a.organizationId, a.brandId, a.userId)).toBe('owner');
    expect(await members.roleInBrand(a.organizationId, b.brandId, a.userId)).toBeNull();
    expect(await members.roleInBrand(b.organizationId, b.brandId, a.userId)).toBeNull();
    expect(await members.roleInBrand(a.organizationId, a.brandId, randomUUID())).toBeNull();
  });

  it('PgWebhookSecrets only resolves active connections of the named platform, by uuid', async () => {
    await store.put(scopeOf(a), 'webhook_secret', new Secret('conn-a-hook'));
    const hit = await hooks.connectionSecret(a.connectionId, 'facebook');
    expect(hit?.externalAccountId).toBe('page-a');
    expect(hit?.secret.reveal()).toBe('conn-a-hook');
    expect(await hooks.connectionSecret(a.connectionId, 'tiktok')).toBeNull();
    expect(await hooks.connectionSecret("x' OR 1=1 --", 'facebook')).toBeNull();
    expect(await hooks.connectionSecret(randomUUID(), 'facebook')).toBeNull();
  });

  it.each(['paused', 'revoked', 'error', 'reconnect_required'])(
    'PgWebhookSecrets resolves nothing for a %s connection',
    async (status) => {
      const t = await seedTenant(h.c, `hook-${status}`);
      await store.put(scopeOf(t), 'webhook_secret', new Secret(`hook-${status}-secret`));
      expect(await hooks.connectionSecret(t.connectionId, 'facebook')).not.toBeNull();
      await h.c.query('UPDATE connection SET status = $2 WHERE id = $1', [t.connectionId, status]);
      expect(await hooks.connectionSecret(t.connectionId, 'facebook')).toBeNull();
    },
  );

  it('PgWebhookSecrets resolves nothing when the secret is unreadable or absent', async () => {
    const t = await seedTenant(h.c, 'hook-nosecret');
    expect(await hooks.connectionSecret(t.connectionId, 'facebook')).toBeNull();
    const other = new PgWebhookSecrets(
      pool,
      new CredentialStore(pool, testKeyring(['k9'])),
      new Map(),
    );
    expect(await other.connectionSecret(a.connectionId, 'facebook')).toBeNull();
  });

  it('PgWebhookSecrets.appSecret returns only configured platforms', () => {
    expect(hooks.appSecret('facebook')?.reveal()).toBe('app-secret-fb');
    expect(hooks.appSecret('youtube')).toBeNull();
  });
});

describe('PgConnectionDirectory', () => {
  const upsert = (t: Tenant, externalAccountId: string, displayName: string | null = null) =>
    dir.upsertPending({
      organizationId: t.organizationId,
      brandId: t.brandId,
      platform: 'facebook',
      externalAccountId,
      displayName,
      grantedScopes: ['read'],
    });

  it('upsertPending + activate: new rows start pending, activation audits', async () => {
    const r = await upsert(a, 'page-new', 'New page');
    expect(r.created).toBe(true);
    expect((await dir.load(r.scope))?.status).toBe('reconnect_required');
    const row = (
      await h.c.query('SELECT status_reason, granted_scopes FROM connection WHERE id = $1', [
        r.scope.connectionId,
      ])
    ).rows[0];
    expect(row).toMatchObject({ status_reason: 'oauth_pending', granted_scopes: ['read'] });
    expect(await dir.activate(r.scope, a.userId)).toBe(true);
    expect((await dir.load(r.scope))?.status).toBe('active');
    const audit = await h.c.query(
      `SELECT actor_user_id, details FROM audit_event
        WHERE subject_id = $1 AND action = 'connection.authorized'`,
      [r.scope.connectionId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_user_id).toBe(a.userId);
    expect(audit.rows[0].details).toEqual({ platform: 'facebook' });
    expect((await upsert(a, 'page-new', 'Renamed')).created).toBe(false);
  });

  it.each(['paused', 'revoked'])(
    'upsertPending leaves the name and scopes of a %s connection untouched',
    async (status) => {
      const r = await upsert(a, `page-meta-${status}`, 'Original');
      await h.c.query('UPDATE connection SET status = $2 WHERE id = $1', [
        r.scope.connectionId,
        status,
      ]);
      const again = await dir.upsertPending({
        organizationId: a.organizationId,
        brandId: a.brandId,
        platform: 'facebook',
        externalAccountId: `page-meta-${status}`,
        displayName: 'Changed',
        grantedScopes: ['write'],
      });
      expect(again.scope.connectionId).toBe(r.scope.connectionId);
      const row = (
        await h.c.query('SELECT display_name, granted_scopes FROM connection WHERE id = $1', [
          r.scope.connectionId,
        ])
      ).rows[0];
      expect(row).toEqual({ display_name: 'Original', granted_scopes: ['read'] });
    },
  );

  it('activate does not resurrect a paused connection', async () => {
    const r = await upsert(a, 'page-paused');
    await h.c.query("UPDATE connection SET status = 'paused' WHERE id = $1", [
      r.scope.connectionId,
    ]);
    expect(await dir.activate(r.scope, a.userId)).toBe(false);
    expect(await statusOf(r.scope.connectionId)).toBe('paused');
  });

  it('activate does not resurrect a revoked connection', async () => {
    const r = await upsert(a, 'page-revoked');
    await h.c.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [
      r.scope.connectionId,
    ]);
    expect(await dir.activate(r.scope, a.userId)).toBe(false);
    expect(await statusOf(r.scope.connectionId)).toBe('revoked');
    const audit = await h.c.query(
      "SELECT 1 FROM audit_event WHERE subject_id = $1 AND action = 'connection.authorized'",
      [r.scope.connectionId],
    );
    expect(audit.rowCount).toBe(0);
  });

  it('activate recovers connections that are in error', async () => {
    const r = await upsert(a, 'page-error');
    await h.c.query("UPDATE connection SET status = 'error' WHERE id = $1", [r.scope.connectionId]);
    expect(await dir.activate(r.scope, a.userId)).toBe(true);
    expect(await statusOf(r.scope.connectionId)).toBe('active');
  });

  it('replaces NUL characters in connector-supplied display names and scopes', async () => {
    const r = await dir.upsertPending({
      organizationId: a.organizationId,
      brandId: a.brandId,
      platform: 'facebook',
      externalAccountId: 'page-nul',
      displayName: 'Cafe\u0000 Roma',
      grantedScopes: ['read\u0000', 'ok'],
    });
    const row = (
      await h.c.query('SELECT display_name, granted_scopes FROM connection WHERE id = $1', [
        r.scope.connectionId,
      ])
    ).rows[0];
    expect(row.display_name).toBe('Cafe� Roma');
    expect(row.granted_scopes).toEqual(['read�', 'ok']);
  });
});

describe('PgRefreshLock', () => {
  const lockPool = () => createPool(h.db.url, { applicationName: 'lock-2', onIdleError: () => {} });

  it('serializes across two pools (two processes)', async () => {
    const pool2 = lockPool();
    const l1 = new PgRefreshLock(pool);
    const l2 = new PgRefreshLock(pool2);
    const order: string[] = [];
    let release!: () => void;
    const first = l1.run(
      scopeOf(a),
      () =>
        new Promise<void>((r) => {
          order.push('1-start');
          release = () => {
            order.push('1-end');
            r();
          };
        }),
    );
    await sleep(50);
    const second = l2.run(scopeOf(a), async () => {
      order.push('2');
    });
    await sleep(200);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['1-start', '1-end', '2']);
    await pool2.end();
  });

  it('times out as transient when the lock is held too long', async () => {
    const pool2 = lockPool();
    const l1 = new PgRefreshLock(pool);
    const l2 = new PgRefreshLock(pool2, { timeoutMs: 300, pollMs: 50 });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = l1.run(scopeOf(a), () => held);
    await sleep(50);
    await expect(l2.run(scopeOf(a), async () => undefined)).rejects.toMatchObject({
      kind: 'transient',
      code: 'refresh_lock_timeout',
    });
    release();
    await first;
    await pool2.end();
  });

  it('releases the lock when the callback throws', async () => {
    const pool2 = lockPool();
    const l1 = new PgRefreshLock(pool);
    const l2 = new PgRefreshLock(pool2, { timeoutMs: 1_000 });
    await expect(
      l1.run(scopeOf(a), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await l2.run(scopeOf(a), async () => 'ok')).toBe('ok');
    await pool2.end();
  });

  it('completes more concurrent refreshes than the data pool has clients (dedicated lock pool)', async () => {
    const dataPool = createPool(h.db.url, {
      applicationName: 'data-2',
      max: 2,
      onIdleError: () => {},
    });
    const lockPool = createPool(h.db.url, {
      applicationName: 'lock-4',
      max: 4,
      onIdleError: () => {},
    });
    const lock = new PgRefreshLock(lockPool, { timeoutMs: 10_000 });
    const scopes = Array.from({ length: 8 }, () => ({
      organizationId: a.organizationId,
      brandId: a.brandId,
      connectionId: randomUUID(),
    }));
    // Like a refresh: hold the lock, then need several data-pool clients in sequence.
    const refresh = (s: ConnectionScope) =>
      lock.run(s, async () => {
        await sleep(100);
        await dataPool.query('SELECT 1');
        await dataPool.query('SELECT 1');
        return 'done';
      });
    expect(await Promise.all(scopes.map(refresh))).toEqual(scopes.map(() => 'done'));
    await Promise.all([dataPool.end(), lockPool.end()]);
  });

  it('reports an unavailable lock pool as transient', async () => {
    const broken = createPool(new URL('postgresql://x:y@127.0.0.1:1/none'), {
      applicationName: 'broken',
      onIdleError: () => {},
    });
    await expect(
      new PgRefreshLock(broken).run(scopeOf(a), async () => 'never'),
    ).rejects.toMatchObject({ kind: 'transient', code: 'refresh_lock_unavailable' });
    await broken.end();
  });

  it('does not make different connections wait for each other', async () => {
    const pool2 = lockPool();
    const l1 = new PgRefreshLock(pool);
    const l2 = new PgRefreshLock(pool2, { timeoutMs: 300 });
    let release!: () => void;
    const first = l1.run(scopeOf(a), () => new Promise<void>((r) => (release = r)));
    await sleep(50);
    expect(await l2.run(scopeOf(b), async () => 'b-ran')).toBe('b-ran');
    release();
    await first;
    await pool2.end();
  });
});

describe('PgDeliveryLedger', () => {
  it('uses processed_job: once per key, rollback on failure', async () => {
    const key = `${a.connectionId}:sha256:${'ab'.repeat(32)}`;
    let runs = 0;
    const work = async () => {
      runs++;
    };
    expect(await ledger.once('webhook:facebook', key, work)).toBe('processed');
    expect(await ledger.once('webhook:facebook', key, work)).toBe('duplicate');
    expect(runs).toBe(1);
    const row = await h.c.query('SELECT queue FROM processed_job WHERE job_id = $1', [key]);
    expect(row.rows.map((r) => r.queue)).toEqual(['webhook:facebook']);

    const failing = `${a.connectionId}:sha256:${'cd'.repeat(32)}`;
    await expect(
      ledger.once('webhook:facebook', failing, async () => {
        throw new Error('deliver failed');
      }),
    ).rejects.toThrow('deliver failed');
    expect(await ledger.once('webhook:facebook', failing, work)).toBe('processed');
    expect(runs).toBe(2);
  });

  it('holds no transaction while the delivery work runs', async () => {
    const key = `${a.connectionId}:sha256:${'12'.repeat(32)}`;
    let openWhileRunning = -1;
    await ledger.once('webhook:facebook', key, async () => {
      const r = await h.c.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE state = 'idle in transaction' AND datname = current_database()`,
      );
      openWhileRunning = r.rows[0].n;
    });
    expect(openWhileRunning).toBe(0);
  });

  it('keeps namespaces apart and refuses a delivery that is still in flight', async () => {
    const key = `${b.connectionId}:sha256:${'ef'.repeat(32)}`;
    let runs = 0;
    const work = async () => {
      runs++;
      await sleep(30);
    };
    const out = await Promise.allSettled([
      ledger.once('webhook:facebook', key, work),
      ledger.once('webhook:facebook', key, work),
      ledger.once('webhook:youtube', key, work),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    expect(out.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(runs).toBe(2);
    expect(await ledger.once('webhook:facebook', key, work)).toBe('duplicate');
  });

  it('lets a retry take over a claim whose worker crashed, once the lease lapsed', async () => {
    const key = `${a.connectionId}:sha256:${'a1'.repeat(32)}`;
    await h.c.query(
      `INSERT INTO processed_job (queue, job_id, processed_by, first_processed_at)
       VALUES ('webhook:facebook', $1, 'crashed-worker', now() - interval '1 hour')`,
      [key],
    );
    let runs = 0;
    const work = async () => {
      runs++;
    };
    expect(await ledger.once('webhook:facebook', key, work)).toBe('processed');
    expect(runs).toBe(1);
    expect(await ledger.once('webhook:facebook', key, work)).toBe('duplicate');
    expect(runs).toBe(1);
  });

  it('does not take over a claim whose lease is still running', async () => {
    const key = `${a.connectionId}:sha256:${'b2'.repeat(32)}`;
    await h.c.query(
      `INSERT INTO processed_job (queue, job_id, processed_by) VALUES ('webhook:facebook', $1, 'other-worker')`,
      [key],
    );
    await expect(ledger.once('webhook:facebook', key, async () => undefined)).rejects.toThrow(
      /still being processed/,
    );
  });
});

describe('PgCredentialVault', () => {
  it('flags reconnect and throws reauthorize for an unreadable credential', async () => {
    const t = await seedTenant(h.c, 'unreadable');
    await vault.writeAccessToken(scopeOf(t), { value: new Secret('t-access'), expiresAt: null });
    const other = new PgCredentialVault(new CredentialStore(pool, testKeyring(['k2'])), pool, log);
    await expect(other.readTokens(scopeOf(t))).rejects.toMatchObject({
      kind: 'auth_expired',
      reauthorize: true,
    });
    const row = (
      await h.c.query('SELECT status, status_reason FROM connection WHERE id = $1', [
        t.connectionId,
      ])
    ).rows[0];
    expect(row).toEqual({ status: 'reconnect_required', status_reason: 'credential_unknown_key' });
    expect(lines.join('\n')).not.toContain('t-access');
  });
});
