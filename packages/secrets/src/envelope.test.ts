import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { CredentialUnreadableError } from './errors.js';
import { Keyring } from './keyring.js';
import {
  MAX_PLAINTEXT_BYTES,
  open,
  parseEnvelope,
  rewrap,
  seal,
  type EnvelopeContext,
} from './envelope.js';

const TOKEN = 'EAAGsentinelAccessToken0123456789abcdefXYZ';
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ringK1 = new Keyring(new Map([['k1', k1]]), 'k1');
const ringBoth = new Keyring(
  new Map([
    ['k1', k1],
    ['k2', k2],
  ]),
  'k2',
);
const ringK2 = new Keyring(new Map([['k2', k2]]), 'k2');
const ctx: EnvelopeContext = {
  organizationId: randomUUID(),
  connectionId: randomUUID(),
  kind: 'access_token',
};

describe('envelope v1', () => {
  it('round-trips and records the key id', async () => {
    const { keyId, blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    expect(keyId).toBe('k1');
    expect(parseEnvelope(blob).keyId).toBe('k1');
    expect((await open(ringK1, blob, ctx)).reveal()).toBe(TOKEN);
  });

  it('never contains the plaintext and is randomized per seal', async () => {
    const a = await seal(ringK1, new Secret(TOKEN), ctx);
    const b = await seal(ringK1, new Secret(TOKEN), ctx);
    expect(a.blob.equals(b.blob)).toBe(false);
    for (const enc of ['utf8', 'base64', 'hex'] as const) {
      expect(a.blob.toString('latin1')).not.toContain(Buffer.from(TOKEN).toString(enc));
    }
  });

  it('rejects every single-bit flip at every byte with a CredentialUnreadableError', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    for (let i = 0; i < blob.length; i++) {
      const t = Buffer.from(blob);
      t[i]! ^= 0x01;
      await expect(open(ringK1, t, ctx), `byte ${i}`).rejects.toBeInstanceOf(
        CredentialUnreadableError,
      );
    }
  });

  it('rejects every truncation and an appended byte', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    for (let n = 0; n < blob.length; n++) {
      await expect(open(ringK1, blob.subarray(0, n), ctx), `len ${n}`).rejects.toBeInstanceOf(
        CredentialUnreadableError,
      );
    }
    await expect(open(ringK1, Buffer.concat([blob, Buffer.from([0])]), ctx)).rejects.toMatchObject({
      reason: 'tampered',
    });
  });

  it('is bound to organization, connection and kind', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    for (const other of [
      { ...ctx, organizationId: randomUUID() },
      { ...ctx, connectionId: randomUUID() },
      { ...ctx, kind: 'refresh_token' as const },
    ]) {
      await expect(open(ringK1, blob, other)).rejects.toMatchObject({ reason: 'tampered' });
    }
  });

  it('reports unknown_key with the key id and no secret material', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    const err = await open(ringK2, blob, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'unknown_key', keyId: 'k1' });
    expect((err as Error).message).toContain('"k1"');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('rewraps onto the active key without touching the data part', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    const r = await rewrap(ringBoth, blob, ctx);
    expect(r).toMatchObject({ keyId: 'k2', changed: true });
    const before = parseEnvelope(blob);
    const after = parseEnvelope(r.blob);
    expect(after.ct.equals(before.ct)).toBe(true);
    expect((await open(ringK2, r.blob, ctx)).reveal()).toBe(TOKEN);
    const again = await rewrap(ringBoth, r.blob, ctx);
    expect(again.changed).toBe(false);
    expect(again.blob.equals(r.blob)).toBe(true);
  });

  it('refuses to rewrap (launder) a record whose data part was tampered', async () => {
    const { blob } = await seal(ringK1, new Secret(TOKEN), ctx);
    const t = Buffer.from(blob);
    t[t.length - 1]! ^= 0x01;
    await expect(rewrap(ringBoth, t, ctx)).rejects.toMatchObject({ reason: 'tampered' });
  });

  it('limits plaintext size without echoing the value', async () => {
    const big = 'x'.repeat(MAX_PLAINTEXT_BYTES + 1);
    const err = await seal(ringK1, new Secret(big), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).not.toContain('xxxx');
  });
});
