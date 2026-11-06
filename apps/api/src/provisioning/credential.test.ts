import * as nodeCrypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import {
  PROVISIONING_TOKEN_RE,
  generateProvisioningCredential,
  matchCredential,
  parseCredentialDigests,
} from './credential.js';

vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const HEX_A = 'AB'.repeat(32);
const HEX_B = 'cd'.repeat(32);

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return (err as Error).message;
  }
  throw new Error('expected an EnvError');
}

afterEach(() => vi.mocked(nodeCrypto.timingSafeEqual).mockClear());

describe('generateProvisioningCredential', () => {
  it('produces an fbp_ token and a sha256 hex digest', () => {
    const { token, digestHex } = generateProvisioningCredential();
    expect(PROVISIONING_TOKEN_RE.test(token.reveal())).toBe(true);
    expect(digestHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseCredentialDigests', () => {
  it.each([undefined, '', '  '])('returns null for %j', (raw) => {
    expect(parseCredentialDigests(raw)).toBeNull();
  });
  it('parses one digest', () => {
    expect(parseCredentialDigests(HEX_B)).toHaveLength(1);
  });
  it('parses two digests, trimmed and case-insensitive', () => {
    const out = parseCredentialDigests(` ${HEX_A} , ${HEX_B} `)!;
    expect(out).toHaveLength(2);
    expect(out[0]!.toString('hex')).toBe(HEX_A.toLowerCase());
  });
  it.each([
    ['three digests', `${HEX_B},${HEX_B},${HEX_B}`],
    ['too short', 'abc'],
    ['63 hex chars', 'a'.repeat(63)],
    ['trailing empty entry', `${HEX_B},`],
    ['non-hex', 'zz'.repeat(32)],
  ])('throws without echoing the input: %s', (_n, raw) => {
    const msg = messageOf(() => parseCredentialDigests(raw));
    expect(msg).toBe(
      'PROVISIONING_CREDENTIAL_SHA256 must be one or two comma-separated SHA-256 hex digests',
    );
    expect(msg).not.toContain(raw);
  });
});

describe('matchCredential', () => {
  it('matches its own digest and returns a fingerprint', () => {
    const { token, digestHex } = generateProvisioningCredential();
    const digests = parseCredentialDigests(digestHex)!;
    expect(matchCredential(token.reveal(), digests)).toEqual({
      fingerprint: digestHex.slice(0, 12),
    });
  });
  it('matches the second digest', () => {
    const a = generateProvisioningCredential();
    const b = generateProvisioningCredential();
    const digests = parseCredentialDigests(`${a.digestHex},${b.digestHex}`)!;
    expect(matchCredential(b.token.reveal(), digests)).toEqual({
      fingerprint: b.digestHex.slice(0, 12),
    });
  });
  it('rejects wrong or malformed tokens', () => {
    const a = generateProvisioningCredential();
    const other = generateProvisioningCredential();
    const digests = parseCredentialDigests(a.digestHex)!;
    expect(matchCredential(other.token.reveal(), digests)).toBeNull();
    expect(matchCredential(`fbk_${'a'.repeat(16)}_${'b'.repeat(43)}`, digests)).toBeNull();
    expect(matchCredential('fbp_', digests)).toBeNull();
    expect(matchCredential(undefined, digests)).toBeNull();
    expect(matchCredential(`${a.token.reveal()} `, digests)).toBeNull();
  });
  it('compares against every digest without short-circuiting', () => {
    const a = generateProvisioningCredential();
    const b = generateProvisioningCredential();
    const digests = parseCredentialDigests(`${a.digestHex},${b.digestHex}`)!;
    expect(matchCredential(a.token.reveal(), digests)).not.toBeNull();
    expect(nodeCrypto.timingSafeEqual).toHaveBeenCalledTimes(2);
  });
});
