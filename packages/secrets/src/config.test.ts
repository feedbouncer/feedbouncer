import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEV_EXAMPLE_ENCRYPTION_KEY, EnvError } from '@feedbouncer/service-runtime';
import { loadEncryptionKeyring } from './config.js';
import { randomKeyEntry } from './testing.js';

const noWarn = () => {};
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return (err as Error).message;
  }
  throw new Error('expected EnvError');
}
const load = (
  keys: string | undefined,
  active: string | null = 'k1',
  appEnv: 'production' | 'development' | 'test' = 'production',
  warn: (msg: string) => void = noWarn,
) =>
  loadEncryptionKeyring(
    { FB_ENCRYPTION_KEYS: keys, FB_ENCRYPTION_ACTIVE_KEY_ID: active ?? undefined },
    appEnv,
    warn,
  );

describe('loadEncryptionKeyring', () => {
  it('loads several keys with exactly one active', () => {
    const ring = load(`${randomKeyEntry('k1')}, ${randomKeyEntry('k0')}`, 'k1');
    expect(ring.activeKeyId).toBe('k1');
    expect(ring.keyIds().sort()).toEqual(['k0', 'k1']);
  });

  it('names missing settings', () => {
    expect(messageOf(() => load(undefined))).toMatch(/FB_ENCRYPTION_KEYS is not set/);
    expect(messageOf(() => load(randomKeyEntry('k1'), null))).toMatch(
      /FB_ENCRYPTION_ACTIVE_KEY_ID is not set/,
    );
  });

  it('requires the active key id to be configured', () => {
    expect(messageOf(() => load(randomKeyEntry('k1'), 'k2'))).toMatch(
      /FB_ENCRYPTION_ACTIVE_KEY_ID names a key id that is not in FB_ENCRYPTION_KEYS/,
    );
  });

  const good = randomBytes(32).toString('base64');
  it.each([
    ['missing separator', good, /entry 1 must look like <key-id>:<base64 key>/],
    ['bad key id', `K_1:${good}`, /entry 1 has an invalid key id/],
    ['quoted', `k1:"${good}"`, /key "k1" must be exactly 32 random bytes/],
    [
      'base64url alphabet',
      `k1:${randomBytes(32).toString('base64url')}`,
      /key "k1" must be exactly 32 random bytes/,
    ],
    [
      '31 bytes',
      `k1:${randomBytes(31).toString('base64')}`,
      /key "k1" must be exactly 32 random bytes/,
    ],
    [
      '33 bytes',
      `k1:${randomBytes(33).toString('base64')}`,
      /key "k1" must be exactly 32 random bytes/,
    ],
    ['hex', `k1:${randomBytes(32).toString('hex')}`, /key "k1" must be exactly 32 random bytes/],
    ['all zero', `k1:${Buffer.alloc(32).toString('base64')}`, /key "k1" has too little entropy/],
    [
      'repeating pattern',
      `k1:${Buffer.alloc(32, 'ab').toString('base64')}`,
      /key "k1" has too little entropy/,
    ],
    [
      'duplicate id',
      `k1:${good},k1:${randomBytes(32).toString('base64')}`,
      /lists key id "k1" more than once/,
    ],
    ['duplicate material', `k1:${good},k2:${good}`, /same key material under two key ids/],
    ['empty entry', `k1:${good},,`, /entry 2 must look like/],
    [
      'too many',
      Array.from({ length: 17 }, (_, i) => randomKeyEntry(`k${i}`)).join(','),
      /more than 16 keys/,
    ],
  ])('rejects %s without echoing material', (_label, raw, pattern) => {
    const msg = messageOf(() => load(raw));
    expect(msg).toMatch(pattern);
    expect(msg).not.toContain(good);
    expect(msg).not.toContain(raw.slice(raw.indexOf(':') + 1, raw.indexOf(':') + 12));
  });

  it('refuses the documented example key in production and warns in development', () => {
    const entry = `dev-example:${DEV_EXAMPLE_ENCRYPTION_KEY}`;
    expect(messageOf(() => load(entry, 'dev-example', 'production'))).toMatch(
      /documented example value/,
    );
    const warnings: string[] = [];
    expect(load(entry, 'dev-example', 'development', (m) => warnings.push(m)).activeKeyId).toBe(
      'dev-example',
    );
    expect(warnings.join('\n')).toMatch(
      /FB_ENCRYPTION_KEYS key "dev-example" uses a documented example value/,
    );
    expect(warnings.join('\n')).not.toContain(DEV_EXAMPLE_ENCRYPTION_KEY);
  });
});
