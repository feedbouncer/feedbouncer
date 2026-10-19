import type { IDataObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { checkExists, create, remove } from '../nodes/FeedBouncerTrigger/lifecycle';
import type { TriggerStaticData } from '../nodes/FeedBouncerTrigger/lifecycle';
import { fakeHook } from './fakes';
import type { FakeInit, Scripted } from './fakes';

const URL_A = 'https://n8n.example.com/webhook/aaa';
const URL_B = 'https://n8n.example.com/webhook/bbb';
const ID_1 = '0b9c2f7e-8a4d-4c1e-9f3a-1d2e3f4a5b6c';
const ID_2 = '1c0d3a8f-9b5e-4d2f-8a4b-2e3f4a5b6c7d';
const ID_3 = '2d1e4b9a-0c6f-4e30-9b5c-3f4a5b6c7d8e';
const SIGNING = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const endpoint = (id: string, url: string, over: Record<string, unknown> = {}) => ({
  id,
  url,
  description: null,
  eventTypes: ['item.flagged'],
  status: 'active',
  ...over,
});
const page = (data: unknown[], nextCursor: string | null = null): Scripted => ({ status: 200, body: { data, nextCursor } });
const created = (id: string): Scripted => ({ status: 201, body: { endpoint: endpoint(id, URL_A), secret: SIGNING } });
const gone: Scripted = { status: 204 };
const apiError = (status: number, code: string): Scripted => ({
  status,
  body: { error: { code, message: `server text ${SIGNING}` } },
});

const hook = (init: FakeInit & { webhookUrl?: string } = {}) =>
  fakeHook({ webhookUrl: URL_A, params: { events: ['item.flagged'] }, ...init });
const stored = (over: Partial<TriggerStaticData> = {}): IDataObject => ({
  endpointId: ID_1,
  secret: SIGNING,
  url: URL_A,
  events: ['item.flagged'],
  ...over,
});
const methods = (ctx: { calls: Array<{ method: string }> }) => ctx.calls.map((c) => c.method);

describe('create', () => {
  it('registers url+events, stores endpointId and secret, request body has no apiKey', async () => {
    const ctx = hook({
      params: { events: ['item.flagged', 'comment.hidden'] },
      http: [page([]), created(ID_1)],
    });
    expect(await create.call(ctx)).toBe(true);
    const post = ctx.calls[1];
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://fb.acme.io/v1/webhook-endpoints');
    expect(post.body).toEqual({
      url: URL_A,
      eventTypes: ['item.flagged', 'comment.hidden'],
      description: 'n8n workflow wf-1, node "FeedBouncer"',
    });
    expect(JSON.stringify(post.body)).not.toMatch(/fbk_|apiKey/);
    expect(ctx.staticData).toMatchObject({ endpointId: ID_1, secret: SIGNING, url: URL_A, events: ['item.flagged', 'comment.hidden'] });
  });

  it.each([['only the prefix', 'whsec_'], ['a short key', 'whsec_AAAA'], ['no prefix', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'], ['no value', undefined]])(
    'rejects an API secret with %s, deletes the new endpoint and stores nothing',
    async (_name, secret) => {
      const ctx = hook({ http: [page([]), { status: 201, body: { endpoint: endpoint(ID_1, URL_A), secret } }, gone] });
      const error = await create.call(ctx).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('FeedBouncer returned an invalid webhook signing secret.');
      expect(methods(ctx)).toEqual(['GET', 'POST', 'DELETE']);
      expect(ctx.calls[2].url).toBe(`https://fb.acme.io/v1/webhook-endpoints/${ID_1}`);
      expect(ctx.staticData.endpointId).toBeUndefined();
    },
  );

  it('keeps the dedupe record in static data', async () => {
    const ctx = hook({ http: [page([]), created(ID_1)], staticData: { seen: { x: 1 } } });
    await create.call(ctx);
    expect(ctx.staticData.seen).toEqual({ x: 1 });
  });

  it('first deletes stored endpoint and same-URL orphans, never other URLs', async () => {
    const ctx = hook({
      staticData: stored(),
      http: [page([endpoint(ID_1, URL_A), endpoint(ID_2, URL_A), endpoint(ID_3, URL_B)]), gone, gone, created(ID_3)],
    });
    await create.call(ctx);
    const deletes = ctx.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual([
      `https://fb.acme.io/v1/webhook-endpoints/${ID_1}`,
      `https://fb.acme.io/v1/webhook-endpoints/${ID_2}`,
    ]);
    expect(methods(ctx)).toEqual(['GET', 'DELETE', 'DELETE', 'POST']);
  });

  it('deletes the stored endpoint even when it is no longer listed, and tolerates a 404', async () => {
    const ctx = hook({
      staticData: stored(),
      http: [page([]), apiError(404, 'not_found'), created(ID_2)],
    });
    expect(await create.call(ctx)).toBe(true);
    expect(ctx.staticData.endpointId).toBe(ID_2);
  });

  it('skips non-UUID ids from the list and from static data, sending nothing with them in the path', async () => {
    const ctx = hook({
      staticData: stored({ endpointId: '../x' }),
      http: [page([endpoint('../y', URL_A), endpoint(ID_2, URL_A)]), gone, created(ID_3)],
    });
    expect(await create.call(ctx)).toBe(true);
    expect(ctx.calls.map((c) => c.url).filter((u) => u.includes('..'))).toEqual([]);
    expect(methods(ctx)).toEqual(['GET', 'DELETE', 'POST']);
  });

  it('walks listWebhookEndpoints pages', async () => {
    const ctx = hook({
      http: [page([endpoint(ID_3, URL_B)], 'c1'), page([endpoint(ID_2, URL_A)]), gone, created(ID_1)],
    });
    await create.call(ctx);
    expect(ctx.calls[1].qs).toMatchObject({ cursor: 'c1' });
    expect(methods(ctx)).toEqual(['GET', 'GET', 'DELETE', 'POST']);
    expect(ctx.calls[2].url).toContain(ID_2);
  });

  it('strips non-ASCII from the description and cuts it to 500', async () => {
    const ctx = hook({ http: [page([]), created(ID_1)] });
    const node = ctx.getNode();
    ctx.getNode = () => ({ ...node, name: `Modér✨${'x'.repeat(600)}` });
    await create.call(ctx);
    const description = String(ctx.calls[1].body?.description);
    expect(description).toHaveLength(500);
    expect(description).toMatch(/^n8n workflow wf-1, node "Mod/);
    expect(description).not.toMatch(/[^\x20-\x7E]/);
  });

  it('422 invalid_webhook_url gives the exact message naming the URL', async () => {
    const ctx = hook({ http: [page([]), apiError(422, 'invalid_webhook_url')] });
    const error = await create.call(ctx).catch((e: Error & { description?: string }) => e);
    expect(error).toMatchObject({
      message: `FeedBouncer can only deliver to a public https:// address on port 443, and this n8n webhook URL is ${URL_A}.`,
      description:
        "Set n8n's public webhook URL (WEBHOOK_URL) to such an address, or ask your FeedBouncer operator to allow your network in WEBHOOK_ALLOWED_PRIVATE_CIDRS.",
    });
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain('whsec_');
  });

  it('409 limit gives the exact message', async () => {
    const ctx = hook({ http: [page([]), apiError(409, 'webhook_endpoint_limit_reached')] });
    const error = await create.call(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: 'This FeedBouncer workspace already has 10 webhook endpoints.',
      description: 'Deactivate another FeedBouncer Trigger workflow or delete unused endpoints in FeedBouncer.',
    });
  });

  it('403 insufficient_scope on create gives the read-only key message', async () => {
    const ctx = hook({ http: [page([]), apiError(403, 'insufficient_scope')] });
    const error = await create.call(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'The API key in credential "FeedBouncer API" is read-only.' });
  });

  it('two nodes with different URLs get separate endpoints; removing one deletes only its own', async () => {
    const a = hook({ webhookUrl: URL_A, http: [page([]), created(ID_1)] });
    const b = hook({ webhookUrl: URL_B, http: [page([endpoint(ID_1, URL_A)]), { status: 201, body: { endpoint: endpoint(ID_2, URL_B), secret: SIGNING } }] });
    await create.call(a);
    await create.call(b);
    expect(methods(b)).toEqual(['GET', 'POST']);
    expect(b.staticData.endpointId).toBe(ID_2);

    const removeA = hook({
      webhookUrl: URL_A,
      staticData: { ...a.staticData },
      http: [page([endpoint(ID_1, URL_A), endpoint(ID_2, URL_B)]), gone],
    });
    await remove.call(removeA);
    expect(removeA.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `https://fb.acme.io/v1/webhook-endpoints/${ID_1}`,
    ]);
  });
});

describe('checkExists', () => {
  const active = (over: Record<string, unknown> = {}): Scripted => ({ status: 200, body: endpoint(ID_1, URL_A, over) });

  it.each([
    ['static data is empty', {}, URL_A, ['item.flagged'], []],
    ['the url changed', stored(), URL_B, ['item.flagged'], []],
    ['the events changed', stored(), URL_A, ['item.flagged', 'comment.hidden'], []],
    ['the secret is missing', stored({ secret: undefined }), URL_A, ['item.flagged'], []],
    ['the endpoint is disabled', stored(), URL_A, ['item.flagged'], [active({ status: 'disabled' })]],
    ['the endpoint url differs', stored(), URL_A, ['item.flagged'], [active({ url: URL_B })]],
    ['the endpoint is gone (404)', stored(), URL_A, ['item.flagged'], [apiError(404, 'not_found')]],
  ] as const)('is false when %s', async (_name, data, webhookUrl, events, http) => {
    const ctx = hook({ webhookUrl, params: { events }, staticData: { ...data }, http: [...http] });
    expect(await checkExists.call(ctx)).toBe(false);
  });

  it('is true when everything matches, ignoring event order', async () => {
    const ctx = hook({
      params: { events: ['comment.hidden', 'item.flagged'] },
      staticData: stored({ events: ['item.flagged', 'comment.hidden'] }),
      http: [active()],
    });
    expect(await checkExists.call(ctx)).toBe(true);
    expect(ctx.calls[0].url).toBe(`https://fb.acme.io/v1/webhook-endpoints/${ID_1}`);
  });

  it('is false without a request when the stored id is not a UUID', async () => {
    const ctx = hook({ staticData: stored({ endpointId: '../x' }), http: [] });
    expect(await checkExists.call(ctx)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });

  it('propagates errors other than 404', async () => {
    const ctx = hook({ staticData: stored(), http: [apiError(401, 'unauthorized')] });
    await expect(checkExists.call(ctx)).rejects.toThrow(/rejected the API key/);
  });
});

describe('remove', () => {
  it('deletes the endpoint and clears static data but keeps the dedupe record', async () => {
    const ctx = hook({ staticData: { ...stored(), seen: { x: 1 } }, http: [page([endpoint(ID_1, URL_A)]), gone] });
    expect(await remove.call(ctx)).toBe(true);
    expect(ctx.staticData).toEqual({ seen: { x: 1 } });
  });

  it('endpoint already deleted (404) gives true and clears static data', async () => {
    const ctx = hook({ staticData: stored(), http: [page([]), apiError(404, 'not_found')] });
    expect(await remove.call(ctx)).toBe(true);
    expect(ctx.staticData.endpointId).toBeUndefined();
    expect(ctx.staticData.secret).toBeUndefined();
  });

  it('skips a non-UUID stored id and still clears and returns true', async () => {
    const ctx = hook({ staticData: stored({ endpointId: '../x' }), http: [page([])] });
    expect(await remove.call(ctx)).toBe(true);
    expect(ctx.calls.map((c) => c.url).filter((u) => u.includes('..'))).toEqual([]);
    expect(ctx.staticData).toEqual({});
  });

  it.each([
    ['unreachable', { throw: { code: 'ECONNREFUSED' } }],
    ['401', apiError(401, 'unauthorized')],
    ['403', apiError(403, 'insufficient_scope')],
  ] as Array<[string, Scripted]>)('API %s gives true without throwing and clears static data', async (_name, failure) => {
    const ctx = hook({ staticData: stored(), http: [failure] });
    expect(await remove.call(ctx)).toBe(true);
    expect(ctx.staticData).toEqual({});
  });
});
