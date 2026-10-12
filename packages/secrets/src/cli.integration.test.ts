import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { main } from './cli.js';
import { loadEncryptionKeyring } from './config.js';
import { CredentialStore } from './credential-store.js';
import { randomKeyEntry } from './testing.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
const e1 = randomKeyEntry('k1');
const e2 = randomKeyEntry('k2');
const TOKEN = 'cli-sentinel-token-5e6f7a8b9c0d';

beforeAll(async () => {
  h = await migratedDb();
  const pool = createPool(h.db.url, { applicationName: 'cli-test', onIdleError: () => {} });
  const t = await seedTenant(h.c, 'cli');
  const ring = loadEncryptionKeyring(
    { FB_ENCRYPTION_KEYS: e1, FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1' },
    'test',
    () => {},
  );
  await new CredentialStore(pool, ring).put(
    { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId },
    'access_token',
    new Secret(TOKEN),
  );
  await pool.end();
});
afterAll(() => h.close());

it('status -> reencrypt --dry-run -> reencrypt -> status shows k1 removable', async () => {
  const env = {
    FB_ENV: 'test',
    DATABASE_URL: h.db.url.href,
    FB_ENCRYPTION_KEYS: `${e2},${e1}`,
    FB_ENCRYPTION_ACTIVE_KEY_ID: 'k2',
  };
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  expect(await main(['status'], env, io)).toBe(0);
  expect(out.join('\n')).toMatch(/credentials not on the active key: 1/);
  out.length = 0;
  // A mistyped flag must not fall through to a real run.
  expect(await main(['reencrypt', '--dryrun'], env, io)).toBe(2);
  expect(await main(['reencrypt', 'dry-run'], env, io)).toBe(2);
  expect(await main(['recheck-connections', '--dryrun'], env, io)).toBe(2);
  expect(out.join('\n')).not.toMatch(/rewrapped|restored/);
  out.length = 0;
  expect(await main(['status'], env, io)).toBe(0);
  expect(out.join('\n')).toMatch(/credentials not on the active key: 1/);
  out.length = 0;
  expect(await main(['reencrypt', '--dry-run'], env, io)).toBe(1); // dry run leaves rows remaining
  expect(out.join('\n')).toMatch(/re-encrypting to active key k2/);
  expect(await main(['reencrypt', '--batch-size', '10'], env, io)).toBe(0);
  out.length = 0;
  expect(await main(['status'], env, io)).toBe(0);
  expect(out.join('\n')).toMatch(/key k1 \(retired\): 0 credentials, safe to remove/);
  out.length = 0;
  expect(await main(['verify'], env, io)).toBe(0);
  expect(await main(['recheck-connections', '--dry-run'], env, io)).toBe(0);
  const all = out.join('\n');
  expect(all).toMatch(/verified 1 credentials, 0 unreadable/);
  expect(all).toMatch(/checked 0 flagged connections/);
  expect(all).not.toContain(TOKEN);
});

it('verify exits 1 and names the connection when a key is missing', async () => {
  const env = {
    FB_ENV: 'test',
    DATABASE_URL: h.db.url.href,
    FB_ENCRYPTION_KEYS: randomKeyEntry('k3'),
    FB_ENCRYPTION_ACTIVE_KEY_ID: 'k3',
  };
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  expect(await main(['verify'], env, io)).toBe(1);
  expect(out.join('\n')).toMatch(/unreadable: connection /);
  expect(out.join('\n')).not.toContain(TOKEN);
});
