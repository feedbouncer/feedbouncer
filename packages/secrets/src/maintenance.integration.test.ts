import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import {
  CredentialStore,
  markReconnectRequired,
  type ConnectionScope,
} from './credential-store.js';
import { seal } from './envelope.js';
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
        // Same key as the row being rewrapped: key_id is unchanged, only the blob differs.
        await new CredentialStore(pool, ringV1).put(
          scopeOf(t),
          'access_token',
          new Secret('refreshed-token-777777777'),
        );
      },
    });
    expect(r.skippedConcurrent).toBe(1);
    expect(r.rewrapped).toBe(0);
    expect(
      (await new CredentialStore(pool, ringBoth).get(scopeOf(t), 'access_token'))!.value.reveal(),
    ).toBe('refreshed-token-777777777');
  });

  it('repairs a key_id column that drifted from the blob header and counts it as rewrapped', async () => {
    await freshDataset(1);
    const t = tenants[0]!;
    // Seal under k2, then make the key_id column claim k1. The envelope CHECK forbids that
    // state, so lift it for the duration of the test and re-add it afterwards.
    await new CredentialStore(pool, ringBoth).put(
      scopeOf(t),
      'access_token',
      new Secret('sealed-under-k2-0000000'),
    );
    const def = (
      await h.c.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'connection_secret_envelope_check'",
      )
    ).rows[0]!.def;
    await h.c.query(
      'ALTER TABLE connection_secret DROP CONSTRAINT connection_secret_envelope_check',
    );
    try {
      await h.c.query("UPDATE connection_secret SET key_id = 'k1' WHERE connection_id = $1", [
        t.connectionId,
      ]);
      expect((await secretsStatus(pool, ringBoth)).removableKeyIds).toEqual([]);
      const r = await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 10 });
      expect(r).toMatchObject({
        scanned: 1,
        rewrapped: 1,
        skippedConcurrent: 0,
        remainingOnOldKeys: 0,
      });
    } finally {
      await h.c.query(
        `ALTER TABLE connection_secret ADD CONSTRAINT connection_secret_envelope_check ${def} NOT VALID`,
      );
    }
    expect((await secretsStatus(pool, ringBoth)).removableKeyIds).toEqual(['k1']);
    expect(
      (await new CredentialStore(pool, ringV2).get(scopeOf(t), 'access_token'))!.value.reveal(),
    ).toBe('sealed-under-k2-0000000');
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

describe('sealed privacy request subjects', () => {
  async function sealedRequest(t: Tenant, keys: Keyring, boundTo?: string) {
    const id = randomUUID();
    const { blob } = await seal(keys, new Secret('[{"platform":"facebook","externalId":"1"}]'), {
      organizationId: t.organizationId,
      connectionId: boundTo ?? id,
      kind: 'privacy_subject',
    });
    await h.c.query(
      `INSERT INTO privacy_request (id, organization_id, kind, mode, requested_via, subject_count, subjects_sealed)
       VALUES ($1, $2, 'erasure', 'execute', 'cli', 1, $3)`,
      [id, t.organizationId, blob],
    );
    return id;
  }
  const keyIdOf = async (id: string) =>
    (
      await h.c.query<{ k: string }>(
        `SELECT convert_from(substring(subjects_sealed FROM 3 FOR get_byte(subjects_sealed, 1)), 'LATIN1') AS k
           FROM privacy_request WHERE id = $1`,
        [id],
      )
    ).rows[0]!.k;

  it('are rewrapped onto the active key, counted by status and verified', async () => {
    await freshDataset(1);
    const t = tenants[0]!;
    const id = await sealedRequest(t, ringV1);
    expect((await secretsStatus(pool, ringBoth)).rowsNotOnActiveKey).toBe(2);
    expect(await reencryptAll(pool, ringBoth, { dryRun: true, batchSize: 5 })).toMatchObject({
      scanned: 2,
      rewrapped: 2,
    });
    expect(await keyIdOf(id)).toBe('k1');
    const r = await reencryptAll(pool, ringBoth, { dryRun: false, batchSize: 5 });
    expect(r).toMatchObject({ scanned: 2, rewrapped: 2, remainingOnOldKeys: 0, unreadable: [] });
    expect(await keyIdOf(id)).toBe('k2');
    expect(await verifyAll(pool, ringV2)).toEqual({ scanned: 2, unreadable: [] });
    expect((await secretsStatus(pool, ringV2)).keys).toEqual([
      { keyId: 'k2', configured: true, active: true, rows: 2 },
    ]);
    await h.c.query('DELETE FROM privacy_request WHERE id = $1', [id]);
  });

  it('are reported unreadable when bound to another request', async () => {
    await freshDataset(1);
    const id = await sealedRequest(tenants[0]!, ringV1, randomUUID());
    const v = await verifyAll(pool, ringV1);
    expect(v.unreadable).toEqual([
      expect.objectContaining({ id, kind: 'privacy_subject', reason: 'tampered' }),
    ]);
    await h.c.query('DELETE FROM privacy_request WHERE id = $1', [id]);
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

describe('recheckConnections state handling', () => {
  const flag = (t: Tenant) =>
    markReconnectRequired(pool, scopeOf(t), new CredentialUnreadableError('unknown_key', 'k1'));
  const statusOf = async (t: Tenant) =>
    (
      await h.c.query('SELECT status, status_reason FROM connection WHERE id = $1', [
        t.connectionId,
      ])
    ).rows[0];

  beforeEach(async () => {
    await h.c.query(
      "UPDATE connection SET status = 'active', status_reason = NULL WHERE status = 'reconnect_required'",
    );
  });

  it('restores each connection to the status it had before it was flagged', async () => {
    await freshDataset(3);
    const before = ['paused', 'active', 'error'] as const;
    for (const [i, t] of tenants.entries()) {
      await h.c.query('UPDATE connection SET status = $2 WHERE id = $1', [
        t.connectionId,
        before[i],
      ]);
      expect(await flag(t)).toBe(true);
    }
    expect(await recheckConnections(pool, ringV1, { dryRun: false })).toMatchObject({
      checked: 3,
      restored: 3,
      stillUnreadable: 0,
      noCredentials: 0,
      unknownPreviousStatus: 0,
    });
    for (const [i, t] of tenants.entries()) {
      expect(await statusOf(t)).toEqual({ status: before[i], status_reason: null });
    }
  });

  it('leaves a connection flagged when its previous status was never recorded', async () => {
    await freshDataset(1);
    const t = tenants[0]!;
    // Flagged without going through markReconnectRequired: no audit event, no previous status.
    await h.c.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'credential_unknown_key' WHERE id = $1",
      [t.connectionId],
    );
    expect(await recheckConnections(pool, ringV1, { dryRun: false })).toMatchObject({
      checked: 1,
      restored: 0,
      unknownPreviousStatus: 1,
    });
    expect(await statusOf(t)).toEqual({
      status: 'reconnect_required',
      status_reason: 'credential_unknown_key',
    });
  });

  it('leaves a flagged connection with no stored credentials flagged and counts it separately', async () => {
    await freshDataset(1);
    const t = tenants[0]!;
    await flag(t);
    await h.c.query('DELETE FROM connection_secret WHERE connection_id = $1', [t.connectionId]);
    expect(await recheckConnections(pool, ringV1, { dryRun: false })).toMatchObject({
      checked: 1,
      restored: 0,
      stillUnreadable: 0,
      noCredentials: 1,
    });
    expect((await statusOf(t)).status).toBe('reconnect_required');
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
