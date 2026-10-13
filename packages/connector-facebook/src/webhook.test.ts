import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';
import { facebookWebhookSpec, parseFeedWebhook, verifyHandshake } from './webhook.js';

const body = (changes: unknown[], entry: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      object: 'page',
      entry: [{ id: '900', time: 1_760_000_100, changes, ...entry }],
    }),
  );
const comment = (value: Record<string, unknown>) => ({
  field: 'feed',
  value: {
    item: 'comment',
    post_id: '900_1',
    comment_id: '900_1_7',
    created_time: 1_760_000_000,
    ...value,
  },
});

describe('parseFeedWebhook', () => {
  it('maps add / edited / hide / unhide / remove', () => {
    const ev = parseFeedWebhook(
      body(['add', 'edited', 'hide', 'unhide', 'remove'].map((verb) => comment({ verb }))),
    );
    expect(ev.map((e) => e.type)).toEqual([
      'comment.created',
      'comment.updated',
      'comment.updated',
      'comment.updated',
      'comment.deleted',
    ]);
    expect(ev[0]).toEqual({
      type: 'comment.created',
      externalAccountId: '900',
      ref: { sourceExternalId: '900_1', externalId: '900_1_7' },
      occurredAt: new Date(1_760_000_000_000),
    });
    expect(ev[1]!.occurredAt).toEqual(new Date(1_760_000_100_000));
    expect(ev[4]!.occurredAt).toEqual(new Date(1_760_000_100_000));
  });

  it('keeps nested replies (parent is resolved on fetch)', () => {
    expect(
      parseFeedWebhook(
        body([comment({ verb: 'add', parent_id: '900_1_3', comment_id: '900_1_8' })]),
      )[0]!.ref.externalId,
    ).toBe('900_1_8');
  });

  it('ignores posts, reactions, other fields and other objects', () => {
    expect(
      parseFeedWebhook(
        body([
          { field: 'feed', value: { item: 'post', verb: 'add', post_id: '900_1' } },
          { field: 'feed', value: { item: 'reaction', verb: 'add' } },
          { field: 'mention', value: {} },
        ]),
      ),
    ).toEqual([]);
    expect(parseFeedWebhook(Buffer.from(JSON.stringify({ object: 'user', entry: [] })))).toEqual(
      [],
    );
  });

  it('drops events with non-conforming ids', () => {
    const hostile = ['../me/accounts', '1?fields=access_token', '1#', 'https://evil.example/x', 7];
    for (const id of hostile) {
      expect(parseFeedWebhook(body([comment({ verb: 'add', comment_id: id })]))).toEqual([]);
      expect(parseFeedWebhook(body([comment({ verb: 'add', post_id: id })]))).toEqual([]);
      expect(parseFeedWebhook(body([comment({ verb: 'add' })], { id }))).toEqual([]);
    }
    expect(parseFeedWebhook(body([comment({ verb: 'add', post_id: '../x' })]))).toEqual([]);
    expect(parseFeedWebhook(body([comment({ verb: 'add' })], { id: '9/../1' }))).toEqual([]);
    expect(parseFeedWebhook(body([comment({ verb: 'add', comment_id: '1_2_3_4' })]))).toEqual([]);
  });

  it('keeps conforming events next to dropped hostile ones', () => {
    const ev = parseFeedWebhook(
      body([
        comment({ verb: 'add', comment_id: '../me/accounts' }),
        comment({ verb: 'add', comment_id: '900_1_9' }),
      ]),
    );
    expect(ev.map((e) => e.ref.externalId)).toEqual(['900_1_9']);
  });

  it('accepts millisecond times and drops unusable ones', () => {
    expect(
      parseFeedWebhook(
        body([comment({ verb: 'add', created_time: 1_760_000_000_123 })]),
      )[0]!.occurredAt.getTime(),
    ).toBe(1_760_000_000_123);
    expect(parseFeedWebhook(body([comment({ verb: 'add', created_time: 'soon' })]))).toEqual([]);
  });

  it('ignores unknown and prototype-named verbs', () => {
    expect(parseFeedWebhook(body([comment({ verb: 'foo' })]))).toEqual([]);
    for (const verb of ['__proto__', 'constructor', 'toString']) {
      expect(parseFeedWebhook(body([comment({ verb })]))).toEqual([]);
    }
  });

  it('drops updated/deleted events when entry.time is unusable', () => {
    for (const time of ['soon', null, -5, 0]) {
      const b = body(
        ['edited', 'hide', 'unhide', 'remove'].map((verb) => comment({ verb })),
        { time },
      );
      expect(parseFeedWebhook(b)).toEqual([]);
    }
    const created = parseFeedWebhook(body([comment({ verb: 'add' })], { time: 'soon' }));
    expect(created.map((e) => e.type)).toEqual(['comment.created']);
  });

  it('returns [] for malformed JSON and caps at 1000 events', () => {
    expect(parseFeedWebhook(Buffer.from('{nope'))).toEqual([]);
    expect(
      parseFeedWebhook(body(Array.from({ length: 1200 }, () => comment({ verb: 'add' })))).length,
    ).toBe(1000);
  });
});

describe('facebookWebhookSpec signature', () => {
  it('is X-Hub-Signature-256 hex HMAC over the raw body, app secret, no timestamp', () => {
    const raw = body([comment({ verb: 'add' })]);
    expect(facebookWebhookSpec.secretSource).toBe('app');
    expect(facebookWebhookSpec.signature).toMatchObject({
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
      encoding: 'hex',
      timestampHeader: null,
    });
    expect(facebookWebhookSpec.signature.signedPayload(raw, null)).toEqual(raw);
    expect(
      createHmac('sha256', 's')
        .update(facebookWebhookSpec.signature.signedPayload(raw, null))
        .digest('hex'),
    ).toHaveLength(64);
  });

  it('parses through the spec', () => {
    expect(facebookWebhookSpec.parse(body([comment({ verb: 'add' })]))).toHaveLength(1);
  });
});

describe('verifyHandshake', () => {
  const token = new Secret('v'.repeat(24));
  it('echoes a well-formed challenge for subscribe + matching token', () => {
    expect(
      verifyHandshake(
        {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'v'.repeat(24),
          'hub.challenge': '1158201444',
        },
        token,
      ),
    ).toEqual({ ok: true, challenge: '1158201444' });
  });
  it.each([
    [{ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }],
    [{ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'v'.repeat(24), 'hub.challenge': '1' }],
    [
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'v'.repeat(24),
        'hub.challenge': '<script>alert(1)</script>',
      },
    ],
    [{ 'hub.mode': 'subscribe', 'hub.verify_token': ['v'.repeat(24)], 'hub.challenge': '1' }],
    [{}],
  ])('refuses %j', (q) => {
    expect(verifyHandshake(q, token)).toEqual({ ok: false });
  });
});
