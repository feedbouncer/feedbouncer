import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_TOLERANCE_SECONDS } from './constants.js';
import { deliveryHeaders, generateSigningSecret, signatureHeader } from './signing.js';

const body = JSON.stringify({ type: 'comment.received', data: { id: 'c1' } });
const now = () => Math.floor(Date.now() / 1000);
const headersFor = (sig: string, id: string, ts: number) => ({
  'webhook-id': id,
  'webhook-timestamp': String(ts),
  'webhook-signature': sig,
});
const verifier = (s: { reveal(): string }) => new Webhook(s.reveal().slice('whsec_'.length));

describe('signing', () => {
  it('generates whsec_ secrets with 32 random bytes', () => {
    const s = generateSigningSecret().reveal();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(generateSigningSecret().reveal()).not.toBe(s);
  });

  it('is verifiable by the reference library', () => {
    const secret = generateSigningSecret();
    const ts = now();
    const sig = signatureHeader([secret], 'evt_1', ts, body);
    expect(sig).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(verifier(secret).verify(body, headersFor(sig, 'evt_1', ts))).toEqual(JSON.parse(body));
  });

  it('signs with every secret so either alone verifies', () => {
    const [a, b] = [generateSigningSecret(), generateSigningSecret()];
    const ts = now();
    const sig = signatureHeader([a, b], 'evt_1', ts, body);
    expect(sig.split(' ')).toHaveLength(2);
    for (const s of [a, b]) {
      expect(verifier(s).verify(body, headersFor(sig, 'evt_1', ts))).toEqual(JSON.parse(body));
    }
  });

  it('fails verification for a body changed by one byte', () => {
    const secret = generateSigningSecret();
    const ts = now();
    const sig = signatureHeader([secret], 'evt_1', ts, body);
    expect(() => verifier(secret).verify(body + ' ', headersFor(sig, 'evt_1', ts))).toThrow();
  });

  it('fails verification outside the documented 300 s tolerance', () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const secret = generateSigningSecret();
    const ts = now() - (SIGNATURE_TOLERANCE_SECONDS + 1);
    const sig = signatureHeader([secret], 'evt_1', ts, body);
    expect(() => verifier(secret).verify(body, headersFor(sig, 'evt_1', ts))).toThrow();
  });

  it('builds the delivery headers', () => {
    expect(
      deliveryHeaders({
        eventId: 'e',
        eventType: 'item.flagged',
        deliveryId: 'd',
        timestampSec: 5,
        signature: 'v1,x',
      }),
    ).toEqual({
      'content-type': 'application/json',
      'user-agent': 'FeedBouncer-Webhooks/1',
      'webhook-id': 'e',
      'webhook-timestamp': '5',
      'webhook-signature': 'v1,x',
      'feedbouncer-event-type': 'item.flagged',
      'feedbouncer-delivery-id': 'd',
    });
  });
});
