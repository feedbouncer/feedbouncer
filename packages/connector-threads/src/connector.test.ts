import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  MemoryDeliveryLedger,
  StaticWebhookSecrets,
  WebhookGate,
  validateConnector,
  type InboundWebhook,
} from '@feedbouncer/connectors';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { THREADS_REQUIRED_SCOPES, THREADS_SCOPES, type ThreadsConfig } from './config.js';
import { createThreadsConnector } from './connector.js';
import { FakeThreads } from './testing/fake-threads.js';

const APP_ID = '1234567890';
const APP_SECRET = 'app-SECRET-0123456789';
const T0 = new Date('2026-10-24T10:00:00Z');
const cfg: ThreadsConfig = {
  appId: APP_ID,
  appSecret: new Secret(APP_SECRET),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};

describe('createThreadsConnector', () => {
  const c = createThreadsConnector(cfg);

  it('passes validateConnector', () => {
    expect(() => validateConnector(c)).not.toThrow();
  });

  it('declares the Threads capabilities', () => {
    expect(c.platform).toBe('threads');
    expect(c.capabilities).toMatchObject({
      actions: ['hide', 'unhide'],
      responses: ['public_reply'],
      listSources: true,
      recentSources: false,
      ingestion: 'webhook_and_polling',
      tokens: { refreshable: true, rotatesRefreshToken: true },
      apiHosts: ['graph.threads.net'],
      authorizationHosts: ['threads.com', 'threads.net'],
      defaultScopes: [...THREADS_SCOPES],
      requiredScopes: [...THREADS_REQUIRED_SCOPES],
      accountSelection: 'multiple',
      oauthCodeParam: 'code',
      constraints: {
        maxReplyChars: { public_reply: 500 },
        hideTopLevelOnly: true,
        publicReplyOnHidden: true,
        hideOwnAccountComments: false,
      },
      responsePriority: 'bulk',
      maxPageSize: 100,
    });
    expect(c.capabilities.actionScopes?.public_reply).toEqual([
      'threads_manage_replies',
      'threads_content_publish',
    ]);
    expect(c.capabilities.accountIdPattern?.test('123')).toBe(true);
    expect(c.capabilities.accountIdPattern?.test('1_2')).toBe(false);
  });
});

describe('Threads webhook through WebhookGate', () => {
  function setup() {
    const fake = new FakeThreads({ appId: APP_ID, appSecret: APP_SECRET, now: () => T0 });
    const owner = fake.addUser();
    const { postId } = fake.addPost(owner.userId);
    const { replyId } = fake.addReply(postId, { at: T0 });
    const registry = new ConnectorRegistry();
    registry.register(createThreadsConnector(cfg));
    const lines: string[] = [];
    const gate = new WebhookGate({
      registry,
      secrets: new StaticWebhookSecrets(new Map([['threads', new Secret(APP_SECRET)]]), new Map()),
      ledger: new MemoryDeliveryLedger(),
      clock: { now: () => T0.getTime() },
      log: createLogger('test', 'debug', (l) => lines.push(l)),
    });
    const delivery = fake.signedDelivery({ replyId });
    const req = (o: Partial<InboundWebhook> = {}): InboundWebhook => ({
      platform: 'threads',
      connectionId: null,
      rawBody: delivery.rawBody,
      headers: delivery.headers,
      ...o,
    });
    return { gate, lines, req, delivery, owner, postId, replyId };
  }

  it('accepts FakeThreads.signedDelivery and hands over the comment event', async () => {
    const s = setup();
    const seen: unknown[] = [];
    const out = await s.gate.handle(s.req(), async (d) => {
      seen.push(...d.events);
    });
    expect(out).toEqual({ status: 'accepted', eventCount: 1 });
    expect(seen).toMatchObject([
      {
        type: 'comment.created',
        externalAccountId: s.owner.userId,
        ref: { sourceExternalId: s.postId, externalId: s.replyId },
      },
    ]);
  });

  it('rejects a tampered byte with check signature_mismatch, and a missing header with signature_missing', async () => {
    const s = setup();
    const tampered = Buffer.from(s.delivery.rawBody);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    const deliver = async () => {};
    expect(await s.gate.handle(s.req({ rawBody: tampered }), deliver)).toEqual({
      status: 'rejected',
    });
    expect(await s.gate.handle(s.req({ headers: {} }), deliver)).toEqual({ status: 'rejected' });
    expect(s.lines.some((l) => l.includes('signature_mismatch'))).toBe(true);
    expect(s.lines.some((l) => l.includes('signature_missing'))).toBe(true);
  });
});
