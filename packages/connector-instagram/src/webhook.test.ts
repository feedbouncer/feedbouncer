import { describe, expect, it } from 'vitest';
import { parseInstagramWebhook, MAX_EVENTS_PER_DELIVERY, instagramWebhookSpec } from './webhook.js';
import { facebookWebhookSpec } from '@feedbouncer/connector-facebook';

const body = (o: unknown) => Buffer.from(JSON.stringify(o));
const change = (v: Record<string, unknown>) => ({
  field: 'comments',
  value: {
    from: { id: '17841400000000009', username: 'fan' },
    comment_id: '17800000000000001',
    text: 'hi',
    media: { id: '17900000000000001', media_product_type: 'FEED' },
    ...v,
  },
});
const delivery = (changes: unknown[], time: number = 1_760_000_000) =>
  body({ object: 'instagram', entry: [{ id: '17841400000000001', time, changes }] });

describe('parseInstagramWebhook', () => {
  it('maps a comment to comment.created keyed by IG account, media and comment', () => {
    expect(parseInstagramWebhook(delivery([change({})]))).toEqual([
      {
        type: 'comment.created',
        externalAccountId: '17841400000000001',
        ref: { sourceExternalId: '17900000000000001', externalId: '17800000000000001' },
        occurredAt: new Date(1_760_000_000_000),
      },
    ]);
  });
  it('accepts entry.time in milliseconds', () => {
    expect(parseInstagramWebhook(delivery([change({})], 1_760_000_000_123))[0]!.occurredAt).toEqual(
      new Date(1_760_000_000_123),
    );
  });
  it('keeps nested replies (parent is resolved on fetch)', () => {
    expect(
      parseInstagramWebhook(delivery([change({ parent_id: '17800000000000000' })])),
    ).toHaveLength(1);
  });
  it.each([
    ['page object', body({ object: 'page', entry: [{ id: '1', time: 1, changes: [change({})] }] })],
    ['other field', delivery([{ field: 'mentions', value: change({}).value }])],
    [
      'live media',
      delivery([change({ media: { id: '17900000000000001', media_product_type: 'LIVE' } })]),
    ],
    ['path traversal id', delivery([change({ comment_id: '../me/accounts' })])],
    ['query injection id', delivery([change({ comment_id: '1?fields=access_token' })])],
    ['url as media id', delivery([change({ media: { id: 'https://evil.example/x' } })])],
    ['missing media', delivery([change({ media: undefined })])],
    [
      'bad account id',
      body({ object: 'instagram', entry: [{ id: '1#', time: 1, changes: [change({})] }] }),
    ],
    ['not json', Buffer.from('{')],
    ['array root', body([])],
  ])('drops %s', (_n, raw) => expect(parseInstagramWebhook(raw)).toEqual([]));
  it(`caps a delivery at ${MAX_EVENTS_PER_DELIVERY} events`, () => {
    const changes = Array.from({ length: MAX_EVENTS_PER_DELIVERY + 1 }, (_, i) =>
      change({ comment_id: String(17800000000000001n + BigInt(i)) }),
    );
    expect(parseInstagramWebhook(delivery(changes))).toHaveLength(MAX_EVENTS_PER_DELIVERY);
  });
  it('never reads comment text into the event (text is fetched on ingest)', () => {
    expect(
      JSON.stringify(parseInstagramWebhook(delivery([change({ text: '<script>x</script>' })]))),
    ).not.toContain('script');
  });
});

describe('instagramWebhookSpec', () => {
  it('uses the app secret and the same signature scheme as Facebook', () => {
    expect(instagramWebhookSpec.secretSource).toBe('app');
    expect(instagramWebhookSpec.signature).toEqual(facebookWebhookSpec.signature);
    expect(instagramWebhookSpec.parse).toBe(parseInstagramWebhook);
  });
});
