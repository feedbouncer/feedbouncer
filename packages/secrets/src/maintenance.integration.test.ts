import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import {
  CredentialStore,
  markReconnectRequired,
  type ConnectionScope,
} from './credential-store.js';
import { CredentialUnreadableError } from './errors.js';
import { Keyring } from './keyring.js';
import { recheckConnections, reencryptAll, secretsStatus, verifyAll } from './maintenance.js';
import { reportKeyCoverage } from './startup.js';

const m1 = randomBytes(32);
const m2 = randomBytes(32);
const ringV1 = new Keyring(new Map([['k1', m1]]), 'k1');
const ringBoth = new Keyring(
  new Map([
    ['k1', m1],
    ['k2', m2],
  ]),
  'k2',
);
const ringV2 = new Keyring(new Map([['k2', m2]]), 'k2');

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
const tenants: Tenant[] = [];
const scopeOf = (t: Tenant): ConnectionScope => ({
  organizationId: t.organizationId,
  brandId: t.brandId,
  connectionId: t.connectionId,
});
const value = (i: number) => `token-${i}-${'x'.repeat(24)}`;

async function freshDataset(n: number) {
  await h.c.query('DELETE FROM connection_secret');
  tenants.length = 0;
  for (let i = 0; i < n; i++) {
    const t = await seedTenant(h.c, `m${Date.now()}-${i}`);
    tenants.push(t);
    await new CredentialStore(pool, ringV1).put(scopeOf(t), 'access_token', new Secret(value(i)));
  }
}
const blobs = async () =>
  (await h.c.query('SELECT id, key_id, encrypted_value FROM connection_secret ORDER BY id')).rows;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'maint-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

describe('reencryptAll', () => {
  it('dry run reports work without writing anything', async () => {
    await freshDataset(7);
    const before = await blobs();
    const r = await reencryptAll(pool, ringBoth, { dryRun: true, batchSize: 3 });
    expect(r).toMatchObject({
      scanned: 7,
      rewrapped: 7,
      skippedConcurrent: 0,
      unreadable: [],
      remainingOnOldKeys: 7,
    });
    expect(await blobs()).toEqual(before);
  });

  it('moves every row to the active key, is readable by a k2-only keyring, and is idempotent', async () => {
    await freshDataset(7);
    const r = await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 3 });
    expect(r).toMatchObject({ rewrapped: 7, remainingOnOldKeys: 0, interrupted: false });
    for (const [i, t] of tenants.entries()) {
      expect(
        (await new CredentialStore(pool, ringV2).get(scopeOf(t), 'access_token'))!.value.reveal(),
      ).toBe(value(i));
    }
    expect(await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 3 })).toMatchObject({
      scanned: 0,
      rewrapped: 0,
    });
  });

  it('is resumable: an interrupted run leaves a valid mix and a re-run finishes', async () => {
    await freshDataset(9);
    const ac = new AbortController();
    const first = await reencryptAll(pool, ringBoth, {
      dryRun: false,
      batchSize: 3,
      signal: ac.signal,
      onBatch: () => ac.abort(),
    });
    expect(first.interrupted).toBe(true);
    expect(first.remainingOnOldKeys).toBeGreaterThan(0);
    expect((await verifyAll(pool, ringBoth)).unreadable).toEqual([]);
    const second = await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 3 });
    expect(second.remainingOnOldKeys).toBe(0);
  });

  it('never overwrites a credential written concurrently (compare-and-swap)', async () => {
    await freshDataset(1);
    const t = tenants[0]!;
    const r = await reencryptAll(pool, ringBoth, {
      dryRun: false,
      batchSize: 10,
      beforeWrite: async () => {
        await new CredentialStore(pool, ringBoth).put(
          scopeOf(t),
          'access_token',
          new Secret('refreshed-token-777777777'),
        );
      },
    });
    expect(r.skippedConcurrent).toBe(1);
    expect(
      (await new CredentialStore(pool, ringBoth).get(scopeOf(t), 'access_token'))!.value.reveal(),
    ).toBe('refreshed-token-777777777');
  });

  it('reports unreadable rows without aborting the run and without rewriting them', async () => {
    await freshDataset(3);
    // Flip the lowest bit of the last ciphertext byte (always a real change).
    await h.c.query(
      `UPDATE connection_secret
          SET encrypted_value = set_byte(encrypted_value, octet_length(encrypted_value) - 1,
                                         get_byte(encrypted_value, octet_length(encrypted_value) - 1) # 1)
        WHERE connection_id = $1`,
      [tenants[1]!.connectionId],
    );
    const r = await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 2 });
    expect(r.rewrapped).toBe(2);
    expect(r.unreadable).toEqual([
      expect.objectContaining({ connectionId: tenants[1]!.connectionId, reason: 'tampered' }),
    ]);
    expect(r.remainingOnOldKeys).toBe(1);
  });
});

describe('secretsStatus', () => {
  it('counts rows per key, flags unconfigured keys and lists removable ones', async () => {
    await freshDataset(4);
    await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 2 });
    const s = await secretsStatus(pool, ringBoth);
    expect(s.activeKeyId).toBe('k2');
    expect(s.keys).toEqual(
      expect.arrayContaining([
        { keyId: 'k2', configured: true, active: true, rows: 4 },
        { keyId: 'k1', configured: true, active: false, rows: 0 },
      ]),
    );
    expect(s.removableKeyIds).toEqual(['k1']);
    expect(s.rowsNotOnActiveKey).toBe(0);
    expect(s.plaintextCredentialColumns).toEqual([]);
    const stale = await secretsStatus(pool, new Keyring(new Map([['k9', randomBytes(32)]]), 'k9'));
    expect(stale.rowsOnUnconfiguredKeys).toBe(4);
    expect(stale.keys).toEqual(
      expect.arrayContaining([{ keyId: 'k2', configured: false, active: false, rows: 4 }]),
    );
  });
});

describe('a process that is missing the new key (rotation done in the wrong order)', () => {
  it('gets a handled unknown_key error naming the key, never garbage', async () => {
    await freshDataset(1);
    await new CredentialStore(pool, ringBoth).put(
      scopeOf(tenants[0]!),
      'access_token',
      new Secret('written-under-k2-000000'),
    );
    const err = await new CredentialStore(pool, ringV1)
      .get(scopeOf(tenants[0]!), 'access_token')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialUnreadableError);
    expect(err).toMatchObject({ reason: 'unknown_key', keyId: 'k2' });
  });
});

describe('recheckConnections', () => {
  it('restores connections whose credentials are readable again, and audits it', async () => {
    await freshDataset(2);
    for (const t of tenants)
      await markReconnectRequired(
        pool,
        scopeOf(t),
        new CredentialUnreadableError('unknown_key', 'k1'),
      );
    expect(await recheckConnections(pool, ringV2, { dryRun: false })).toMatchObject({
      checked: 2,
      restored: 0,
      stillUnreadable: 2,
    });
    expect(await recheckConnections(pool, ringV1, { dryRun: true })).toMatchObject({
      checked: 2,
      restored: 2,
    });
    expect(
      (
        await h.c.query(
          "SELECT count(*)::int AS n FROM connection WHERE status = 'reconnect_required'",
        )
      ).rows[0].n,
    ).toBe(2);
    expect(await recheckConnections(pool, ringV1, { dryRun: false })).toMatchObject({
      restored: 2,
    });
    const { rows } = await h.c.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE action = 'connection.credentials_restored' AND subject_id = ANY($1::uuid[])",
      [tenants.map((t) => t.connectionId)],
    );
    expect(rows[0].n).toBe(2);
  });
});

describe('reportKeyCoverage', () => {
  it('warns about rows on unconfigured keys with ids and counts only', async () => {
    await freshDataset(2);
    const lines: string[] = [];
    await reportKeyCoverage(
      pool,
      ringV2,
      createLogger('t', 'debug', (l) => lines.push(l)),
    );
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.level === 'warn');
    expect(warn).toMatchObject({
      msg: 'stored credentials reference an encryption key that is not configured',
      keyId: 'k1',
      rows: 2,
    });
  });
});
