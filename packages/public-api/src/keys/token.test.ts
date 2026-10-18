import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateApiKey, parseApiKey, scopeAllows } from './token.js';

describe('generateApiKey', () => {
  it('produces fbk_<16 base32>_<43 base64url>', () => {
    expect(generateApiKey().token.reveal()).toMatch(/^fbk_[a-z2-7]{16}_[A-Za-z0-9_-]{43}$/);
  });

  it('is unique per call and hashes the secret part only', () => {
    const a = generateApiKey();
    expect(generateApiKey().publicId).not.toBe(a.publicId);
    const secret = a.token.reveal().split('_')[2]!;
    expect(a.secretSha256.equals(createHash('sha256').update(secret).digest())).toBe(true);
  });
});

describe('parseApiKey', () => {
  it('round-trips the public id and secret hash', () => {
    const k = generateApiKey();
    const parsed = parseApiKey(k.token.reveal());
    expect(parsed?.publicId).toBe(k.publicId);
    expect(parsed?.secretSha256.equals(k.secretSha256)).toBe(true);
  });

  const good = generateApiKey().token.reveal();
  const [, id, secret] = good.split('_') as [string, string, string];
  it.each([
    ['empty', ''],
    ['bearer prefix', 'Bearer x'],
    ['short secret', `fbk_${id}_${secret.slice(1)}`],
    ['long secret', `fbk_${id}_${secret}A`],
    ['uppercase public id', `fbk_${id.toUpperCase()}_${secret}`],
    ['trailing newline', `${good}\n`],
  ])('rejects %s', (_n, raw) => expect(parseApiKey(raw)).toBeNull());
});

describe('scopeAllows', () => {
  it('write implies read, read does not imply write', () => {
    expect(scopeAllows('write', 'read')).toBe(true);
    expect(scopeAllows('read', 'read')).toBe(true);
    expect(scopeAllows('write', 'write')).toBe(true);
    expect(scopeAllows('read', 'write')).toBe(false);
  });
});
