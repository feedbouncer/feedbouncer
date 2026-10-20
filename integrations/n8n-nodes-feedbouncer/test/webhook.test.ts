import { randomBytes } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { FeedBouncerTrigger } from '../nodes/FeedBouncerTrigger/FeedBouncerTrigger.node';
import { sealSecret } from '../nodes/FeedBouncerTrigger/secretBox';
import { API_KEY, fakeWebhook } from './fakes';

const SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const node = new FeedBouncerTrigger();
const SEALED = sealSecret(SECRET, API_KEY);

function delivery(event: Record<string, unknown>, over: { id?: string; events?: string[]; staticData?: IDataObject; tamper?: boolean; rawBody?: unknown; text?: string; unsigned?: boolean } = {}) {
  const id = over.id ?? 'evt_1';
  const body = over.text ?? JSON.stringify(event);
  const ts = new Date();
  const signature = new Webhook(SECRET).sign(id, ts, over.tamper ? `${body} ` : body);
  const headers: Record<string, string> = over.unsigned
    ? {}
    : {
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)),
        'webhook-signature': signature,
        'feedbouncer-delivery-id': 'dlv_1',
      };
  return fakeWebhook({
    params: { events: over.events ?? ['comment.hidden'] },
    staticData: over.staticData ?? { sealedSecret: SEALED },
    headers,
    rawBody: 'rawBody' in over ? over.rawBody : body,
  });
}

const HIDDEN = { id: 'evt_1', type: 'comment.hidden', data: { comment: { text: 'hi' } } };

describe('FeedBouncerTrigger.webhook', () => {
  it('accepts a test-listen delivery signed with the test secret and keeps the production secret for production', async () => {
    const url = 'https://n8n.example.com/webhook/abc';
    const testStatic = { sealedSecret: sealSecret('whsec_other', 'fbk_test'), test: { endpointId: 'x', sealedSecret: SEALED, url } };
    const result = await node.webhook.call(delivery(HIDDEN, { staticData: testStatic }));
    expect(result.workflowData).toBeDefined();
    const other = { ...testStatic, test: { ...testStatic.test, url: 'https://n8n.example.com/webhook-test/abc' } };
    const rejected = delivery(HIDDEN, { staticData: other });
    await node.webhook.call(rejected);
    expect(rejected.response.status).toBe(401);
  });

  it('emits the parsed event with the delivery id', async () => {
    const ctx = delivery(HIDDEN);
    const result = await node.webhook.call(ctx);
    expect(result.workflowData).toEqual([[{ json: { ...HIDDEN, deliveryId: 'dlv_1' } }]]);
    expect(ctx.response.status).toBeUndefined();
  });

  it('rejects an invalid signature with 401', async () => {
    const ctx = delivery(HIDDEN, { tamper: true });
    const result = await node.webhook.call(ctx);
    expect(result).toEqual({ noWebhookResponse: true });
    expect(ctx.response).toEqual({ status: 401, body: { error: 'invalid_signature' } });
  });

  it('rejects an unsigned delivery with 401', async () => {
    const ctx = delivery(HIDDEN, { unsigned: true });
    const result = await node.webhook.call(ctx);
    expect(result.workflowData).toBeUndefined();
    expect(ctx.response.status).toBe(401);
  });

  it('rejects when the stored secret was sealed under another api key', async () => {
    const ctx = delivery(HIDDEN, { staticData: { sealedSecret: sealSecret(SECRET, 'fbk_rotated') } });
    const result = await node.webhook.call(ctx);
    expect(result.workflowData).toBeUndefined();
    expect(ctx.response.status).toBe(401);
  });

  it('rejects a clear-text secret left by an older version', async () => {
    const ctx = delivery(HIDDEN, { staticData: { secret: SECRET } });
    const result = await node.webhook.call(ctx);
    expect(result.workflowData).toBeUndefined();
    expect(ctx.response.status).toBe(401);
  });

  it('rejects when no signing secret is stored', async () => {
    const ctx = delivery(HIDDEN, { staticData: {} });
    const result = await node.webhook.call(ctx);
    expect(result.workflowData).toBeUndefined();
    expect(ctx.response.status).toBe(401);
  });

  it.each([['a string', '{"type":"comment.hidden"}'], ['undefined', undefined], ['an object', { type: 'comment.hidden' }]])(
    'fails closed when rawBody is %s',
    async (_name, rawBody) => {
      const ctx = delivery(HIDDEN, { rawBody });
      const result = await node.webhook.call(ctx);
      expect(result.workflowData).toBeUndefined();
      expect(ctx.response.status).toBe(401);
    },
  );

  it('does not mark a rejected delivery as seen', async () => {
    const staticData: { sealedSecret: string; seen?: object } = { sealedSecret: SEALED };
    await node.webhook.call(delivery(HIDDEN, { staticData, tamper: true }));
    expect(staticData.seen).toBeUndefined();
    const result = await node.webhook.call(delivery(HIDDEN, { staticData }));
    expect(result.workflowData).toHaveLength(1);
  });

  it('delivers a repeated webhook-id once', async () => {
    const staticData = { sealedSecret: SEALED };
    const first = await node.webhook.call(delivery(HIDDEN, { staticData }));
    const ctx = delivery(HIDDEN, { staticData });
    const second = await node.webhook.call(ctx);
    expect(first.workflowData).toHaveLength(1);
    expect(second).toEqual({ webhookResponse: 'ok' });
    expect(ctx.response.status).toBeUndefined();
  });

  it('acknowledges webhook.test without starting the workflow', async () => {
    const staticData: { sealedSecret: string; seen?: object } = { sealedSecret: SEALED };
    const result = await node.webhook.call(delivery({ id: 'evt_1', type: 'webhook.test', data: {} }, { staticData, events: ['webhook.test'] }));
    expect(result).toEqual({ webhookResponse: 'ok' });
    expect(staticData.seen).toBeUndefined();
  });

  it('acknowledges event types the node did not select, without marking them seen', async () => {
    const staticData: { sealedSecret: string; seen?: object } = { sealedSecret: SEALED };
    const result = await node.webhook.call(delivery({ ...HIDDEN, type: 'comment.received' }, { staticData }));
    expect(result).toEqual({ webhookResponse: 'ok' });
    expect(staticData.seen).toBeUndefined();
  });

  it('passes emoji and 10,000 astral code points through unchanged', async () => {
    const text = `\u{1F600}é${'\u{1D11E}'.repeat(10_000)} `;
    const event = { id: 'evt_1', type: 'comment.hidden', data: { comment: { text } } };
    const result = await node.webhook.call(delivery(event));
    const json = result.workflowData?.[0]?.[0]?.json as { data: { comment: { text: string } } };
    expect(json.data.comment.text).toBe(text);
  });

  it('never puts the signing secret in a response or an error', async () => {
    const seen: string[] = [];
    for (const over of [{ tamper: true }, { unsigned: true }, { rawBody: 42 }, {}]) {
      const ctx = delivery(HIDDEN, over);
      try {
        seen.push(JSON.stringify(await node.webhook.call(ctx)), JSON.stringify(ctx.response));
      } catch (error) {
        seen.push(String(error));
      }
    }
    for (const text of seen) expect(text).not.toContain(SECRET.slice('whsec_'.length));
  });

  it('answers 400 to a correctly signed body that is not a JSON object', async () => {
    for (const text of ['not json', '[1]', 'null']) {
      const ctx = delivery(HIDDEN, { text });
      const result = await node.webhook.call(ctx);
      expect(result).toEqual({ noWebhookResponse: true });
      expect(ctx.response).toEqual({ status: 400, body: { error: 'invalid_body' } });
    }
  });
});
