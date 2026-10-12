import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CredentialUnreadableError } from './errors.js';
import { Keyring } from './keyring.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const aad = Buffer.from('ctx');

describe('Keyring', () => {
  const ring = new Keyring(
    new Map([
      ['k1', k1],
      ['k2', k2],
    ]),
    'k2',
  );

  it('wraps with the active key and unwraps with the recorded key id', async () => {
    const dek = randomBytes(32);
    const { keyId, wrapped } = await ring.wrap(dek, aad);
    expect(keyId).toBe('k2');
    expect(wrapped).toHaveLength(60);
    expect(await ring.unwrap(keyId, wrapped, aad)).toEqual(dek);
  });

  it('unwraps a DEK wrapped under a retired key', async () => {
    const old = new Keyring(new Map([['k1', k1]]), 'k1');
    const dek = randomBytes(32);
    const { wrapped } = await old.wrap(dek, aad);
    expect(await ring.unwrap('k1', wrapped, aad)).toEqual(dek);
  });

  it('reports unknown_key, tampered and malformed distinctly', async () => {
    const { wrapped } = await ring.wrap(randomBytes(32), aad);
    await expect(ring.unwrap('k9', wrapped, aad)).rejects.toMatchObject({
      reason: 'unknown_key',
      keyId: 'k9',
    });
    const flipped = Buffer.from(wrapped);
    flipped[20]! ^= 1;
    await expect(ring.unwrap('k2', flipped, aad)).rejects.toMatchObject({ reason: 'tampered' });
    await expect(ring.unwrap('k2', wrapped, Buffer.from('other'))).rejects.toMatchObject({
      reason: 'tampered',
    });
    await expect(ring.unwrap('k2', wrapped.subarray(0, 59), aad)).rejects.toBeInstanceOf(
      CredentialUnreadableError,
    );
  });

  it('never exposes key material through JSON or inspect', () => {
    const b64 = [k1.toString('base64'), k2.toString('base64'), k1.toString('hex')];
    for (const out of [
      JSON.stringify({ ring }),
      inspect({ ring }, { depth: 10, showHidden: true }),
      inspect(ring, { customInspect: false, showHidden: true }),
    ]) {
      for (const m of b64) expect(out).not.toContain(m);
    }
    expect(JSON.parse(JSON.stringify(ring))).toEqual({ activeKeyId: 'k2', keyIds: ['k1', 'k2'] });
  });

  it('does not alias caller buffers', async () => {
    const material = randomBytes(32);
    const r = new Keyring(new Map([['a', material]]), 'a');
    const dek = randomBytes(32);
    const { wrapped } = await r.wrap(dek, aad);
    material.fill(0);
    expect(await r.unwrap('a', wrapped, aad)).toEqual(dek);
  });
});
