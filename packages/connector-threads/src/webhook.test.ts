import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import type { ThreadsConfig } from './config.js';
import { parseThreadsWebhook, threadsWebhookSpec } from './webhook.js';

const APP_ID = '1234567890';

const value = (o: Record<string, unknown> = {}) => ({
  id: '17840000000000010',
  username: 'stranger',
  text: 'hello',
  media_type: 'TEXT_POST',
  permalink: 'https://www.threads.com/@stranger/post/C1',
  replied_to: { id: '17840000000000001' },
  root_post: { id: '17840000000000001', owner_id: '17840000000000099', username: 'owner' },
  shortcode: 'C1',
  timestamp: '2026-10-01T10:00:00+0000',
  ...o,
});
const item = (v: unknown = value(), field = 'replies') => ({ value: v, field });
const body = (values: unknown, top: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      app_id: APP_ID,
      topic: 'moderate',
      target_id: '17840000000000099',
      time: 1_760_000_000,
      subscription_id: '17841000000000001',
      values,
      ...top,
    }),
  );

describe('parseThreadsWebhook', () => {
  it('parses the documented sample payload into one comment.created', () => {
    expect(parseThreadsWebhook(body(item()), APP_ID)).toEqual([
      {
        type: 'comment.created',
        externalAccountId: '17840000000000099',
        ref: { sourceExternalId: '17840000000000001', externalId: '17840000000000010' },
        occurredAt: new Date('2026-10-01T10:00:00Z'),
      },
    ]);
  });

  it('drops other app_id, other fields (mentions, delete) and malformed ids', () => {
    expect(parseThreadsWebhook(body(item(), { app_id: '999' }), APP_ID)).toEqual([]);
    expect(parseThreadsWebhook(body(item(value(), 'mentions')), APP_ID)).toEqual([]);
    expect(parseThreadsWebhook(body(item(value(), 'delete')), APP_ID)).toEqual([]);
    const bad = ['../me', '1?x=1', 'abc', 7, null];
    for (const id of bad) {
      expect(parseThreadsWebhook(body(item(value({ id }))), APP_ID)).toEqual([]);
      const root = { id, owner_id: '1' };
      expect(parseThreadsWebhook(body(item(value({ root_post: root }))), APP_ID)).toEqual([]);
      const owner = { id: '1', owner_id: id };
      expect(parseThreadsWebhook(body(item(value({ root_post: owner }))), APP_ID)).toEqual([]);
    }
  });

  it('keeps good items next to dropped ones', () => {
    const ev = parseThreadsWebhook(
      body([item(value({ id: 'x' })), item(value({ id: '55' }))]),
      APP_ID,
    );
    expect(ev.map((e) => e.ref.externalId)).toEqual(['55']);
  });

  it('accepts values as an array of 2', () => {
    const ev = parseThreadsWebhook(
      body([item(value({ id: '11' })), item(value({ id: '12' }))]),
      APP_ID,
    );
    expect(ev.map((e) => e.ref.externalId)).toEqual(['11', '12']);
  });

  it('never reads text or username', () => {
    const [ev] = parseThreadsWebhook(
      body(item(value({ text: '<script>', username: 'evil<b>' }))),
      APP_ID,
    );
    expect(JSON.stringify(ev)).not.toMatch(/script|evil/);
    expect(Object.keys(ev!).sort()).toEqual(['externalAccountId', 'occurredAt', 'ref', 'type']);
  });

  it('a 101-item values array is rejected', () => {
    expect(parseThreadsWebhook(body(Array.from({ length: 101 }, () => item())), APP_ID)).toEqual(
      [],
    );
    expect(
      parseThreadsWebhook(body(Array.from({ length: 100 }, () => item())), APP_ID),
    ).toHaveLength(100);
  });

  it('returns [] for malformed JSON and unusable timestamps', () => {
    expect(parseThreadsWebhook(Buffer.from('{nope'), APP_ID)).toEqual([]);
    expect(parseThreadsWebhook(body(item(value({ timestamp: 'soon' }))), APP_ID)).toEqual([]);
  });
});

describe('threadsWebhookSpec', () => {
  const cfg: ThreadsConfig = {
    appId: APP_ID,
    appSecret: new Secret('s'.repeat(16)),
    webhookVerifyToken: null,
    pollIntervalSec: 600,
    discoveryIntervalSec: 900,
  };
  it('is an X-Hub-Signature-256 hex HMAC over the raw body with the app secret', () => {
    const spec = threadsWebhookSpec(cfg);
    const raw = body(item());
    expect(spec.secretSource).toBe('app');
    expect(spec.signature).toMatchObject({
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
      encoding: 'hex',
      timestampHeader: null,
    });
    expect(spec.signature.signedPayload(raw, null)).toBe(raw);
    expect(spec.parse(raw)).toHaveLength(1);
  });
});
