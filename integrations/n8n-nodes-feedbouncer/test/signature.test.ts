import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../nodes/FeedBouncerTrigger/signature';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const ID = 'evt_1';
const NOW = 1_800_000_000;
const BODY = '{"type":"comment.hidden","data":{"a":1}}';

const sign = (ts: number, body = BODY, secret = SECRET) => new Webhook(secret).sign(ID, new Date(ts * 1000), body);

const verify = (over: Partial<Parameters<typeof verifySignature>[0]> = {}, ts = NOW) =>
  verifySignature({
    secret: SECRET,
    id: ID,
    timestamp: String(ts),
    signatureHeader: sign(ts),
    rawBody: Buffer.from(BODY),
    nowSec: NOW,
    ...over,
  });

describe('verifySignature', () => {
  it('accepts a Standard Webhooks signature', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('enforces a 300 second tolerance in both directions', () => {
    expect(verify({}, NOW - 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verify({}, NOW - 299)).toEqual({ ok: true });
    expect(verify({}, NOW + 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects malformed timestamps', () => {
    for (const timestamp of ['abc', '-5', '1.5', '1'.repeat(13), '']) {
      expect(verify({ timestamp }).ok).toBe(false);
    }
  });

  it('verifies the raw bytes, not a re-serialised body', () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verify({ rawBody: Buffer.from(pretty) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts when any listed signature matches (rotation)', () => {
    const bad = sign(NOW, BODY, `whsec_${randomBytes(32).toString('base64')}`);
    expect(verify({ signatureHeader: `${bad} ${sign(NOW)}` })).toEqual({ ok: true });
  });

  it('rejects a short signature without throwing', () => {
    expect(verify({ signatureHeader: 'v1,AAAA' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects other signature versions', () => {
    expect(verify({ signatureHeader: sign(NOW).replace('v1,', 'v2,') })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects garbage headers without throwing', () => {
    for (const signatureHeader of ['v1', 'v1,', 'v1,!!!', '   ', 'x'.repeat(10_000)]) {
      expect(verify({ signatureHeader })).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('reports missing headers', () => {
    expect(verify({ id: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('reports a missing secret', () => {
    expect(verify({ secret: undefined })).toEqual({ ok: false, reason: 'no_secret' });
    expect(verify({ secret: '' })).toEqual({ ok: false, reason: 'no_secret' });
  });

  it.each([
    ['only the prefix', 'whsec_'],
    ['a key shorter than 24 bytes', `whsec_${randomBytes(23).toString('base64')}`],
    ['no whsec_ prefix', randomBytes(32).toString('base64')],
  ])('fails closed for a secret with %s', (_name, secret) => {
    expect(verify({ secret })).toEqual({ ok: false, reason: 'no_secret' });
  });

  it('accepts a key of exactly 24 bytes', () => {
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    expect(verify({ secret, signatureHeader: sign(NOW, BODY, secret) })).toEqual({ ok: true });
  });
});
