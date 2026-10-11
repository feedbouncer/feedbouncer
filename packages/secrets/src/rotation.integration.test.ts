// Acceptance: rotation without downtime. Readers and a refresh writer keep
// running while re-encryption moves every row from k1 to k2. No read may fail
// or return a value that was never written, and the newest write must survive.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { CredentialStore, type ConnectionScope } from './credential-store.js';
import { Keyring } from './keyring.js';
import { reencryptAll, secretsStatus } from './maintenance.js';

const m1 = randomBytes(32);
const m2 = randomBytes(32);
const phase1 = new Keyring(new Map([['k1', m1]]), 'k1');
// Phase 2 of the documented procedure: every process has both keys, and k2 is active.
const phase2 = new Keyring(
  new Map([
    ['k1', m1],
    ['k2', m2],
  ]),
  'k2',
);

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
const scopes: ConnectionScope[] = [];
const history = new Map<string, Set<string>>();
const last = new Map<string, string>();

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'rotation-test', max: 12, onIdleError: () => {} });
  const seedStore = new CredentialStore(pool, phase1);
  for (let i = 0; i < 40; i++) {
    const t = await seedTenant(h.c, `rot-${i}`);
    const scope = {
      organizationId: t.organizationId,
      brandId: t.brandId,
      connectionId: t.connectionId,
    };
    scopes.push(scope);
    const v = `initial-${i}-${'y'.repeat(20)}`;
    history.set(scope.connectionId, new Set([v]));
    last.set(scope.connectionId, v);
    await seedStore.put(scope, 'access_token', new Secret(v));
  }
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

it('rotates k1 -> k2 while reads and refresh writes continue', async () => {
  const store = new CredentialStore(pool, phase2);
  let stop = false;
  let reads = 0;
  const failures: unknown[] = [];

  const reader = async () => {
    while (!stop) {
      const s = scopes[Math.floor(Math.random() * scopes.length)]!;
      try {
        const v = (await store.get(s, 'access_token'))!.value.reveal();
        if (!history.get(s.connectionId)!.has(v))
          failures.push(new Error('read a value that was never written'));
        reads++;
      } catch (err) {
        failures.push(err);
      }
    }
  };
  const writer = async () => {
    for (let n = 0; n < 60; n++) {
      const s = scopes[n % scopes.length]!;
      const v = `refreshed-${n}-${'z'.repeat(20)}`;
      history.get(s.connectionId)!.add(v); // add before the write: a reader may see it the moment it commits
      await store.put(s, 'access_token', new Secret(v));
      last.set(s.connectionId, v);
    }
  };

  const readers = Array.from({ length: 4 }, reader);
  const [report] = await Promise.all([
    reencryptAll(pool, phase2, { dryRun: false, batchSize: 5 }),
    writer(),
  ]);
  stop = true;
  await Promise.all(readers);

  expect(failures).toEqual([]);
  expect(reads).toBeGreaterThan(0);
  expect(report.unreadable).toEqual([]);
  const final = await reencryptAll(pool, phase2, { dryRun: false, batchSize: 5 }); // picks up any CAS skips
  expect(final.remainingOnOldKeys).toBe(0);
  expect((await secretsStatus(pool, phase2)).removableKeyIds).toEqual(['k1']);
  for (const s of scopes) {
    expect((await store.get(s, 'access_token'))!.value.reveal()).toBe(last.get(s.connectionId));
  }
});
