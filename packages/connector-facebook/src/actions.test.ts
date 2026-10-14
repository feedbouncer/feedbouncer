import { describe, expect, it, vi } from 'vitest';
import { createSafeHttp, type ActionRequest } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from './testing/index.js';
import type { FacebookConfig } from './config.js';
import { PRIVATE_REPLY_INELIGIBLE, act, lifecycle, respond } from './actions.js';

const cfg: FacebookConfig = {
  appId: '111',
  appSecret: new Secret('APP-SECRET'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};
const now = () => Date.parse('2026-10-13T10:00:00Z');

type Route = (url: URL, init: RequestInit) => unknown;
function graph(routes: Record<string, Route>, status = 200) {
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const key = `${init.method} ${url.pathname}`;
    const h = routes[key];
    if (!h) {
      return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(h(url, init)), { status });
  });
  return {
    fetch,
    ctx: {
      accessToken: new Secret('PAGE-TOKEN'),
      externalAccountId: '900',
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
      signal: AbortSignal.timeout(1000),
      reportQuota: vi.fn(async () => undefined),
    },
  };
}

/** One route answering with a Graph error body and the given HTTP status. */
function failing(key: string, error: Record<string, unknown>, status = 400) {
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    if (`${init.method} ${url.pathname}` !== key) {
      return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify({ error: { message: 'RAW-GRAPH-MESSAGE', ...error } }), {
      status,
    });
  });
  return {
    fetch,
    ctx: {
      accessToken: new Secret('PAGE-TOKEN'),
      externalAccountId: '900',
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
      signal: AbortSignal.timeout(1000),
      reportQuota: vi.fn(async () => undefined),
    },
  };
}

const target = { sourceExternalId: '900_1', externalId: '900_1_7' };
const req = (action: ActionRequest['action'], authorExternalId?: string): ActionRequest => ({
  action,
  target,
  ...(authorExternalId !== undefined ? { authorExternalId } : {}),
});
const calls = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([u, i]) => `${(i as RequestInit).method} ${(u as URL).pathname}`);

describe('act', () => {
  it('hide posts is_hidden=true and is applied', async () => {
    const { fetch, ctx } = graph({ 'POST /v26.0/900_1_7': () => ({ success: true }) });
    await expect(act(cfg, now, ctx, req('hide'))).resolves.toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(calls(fetch)).toEqual(['POST /v26.0/900_1_7']);
    const init = fetch.mock.calls[0]![1];
    expect(init.body).toBe('is_hidden=true');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer PAGE-TOKEN');
    expect(String(fetch.mock.calls[0]![0])).not.toContain('PAGE-TOKEN');
  });

  it('unhide posts is_hidden=false', async () => {
    const { fetch, ctx } = graph({ 'POST /v26.0/900_1_7': () => ({ success: true }) });
    await expect(act(cfg, now, ctx, req('unhide'))).resolves.toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(fetch.mock.calls[0]![1].body).toBe('is_hidden=false');
  });

  it('hide that is not confirmed is transient', async () => {
    const { ctx } = graph({ 'POST /v26.0/900_1_7': () => ({ success: false }) });
    await expect(act(cfg, now, ctx, req('hide'))).rejects.toMatchObject({
      kind: 'transient',
      code: 'action_not_confirmed',
    });
  });

  it('delete sends DELETE and is applied', async () => {
    const { fetch, ctx } = graph({ 'DELETE /v26.0/900_1_7': () => ({ success: true }) });
    await expect(act(cfg, now, ctx, req('delete'))).resolves.toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(calls(fetch)).toEqual(['DELETE /v26.0/900_1_7']);
  });

  it('delete on a missing comment is not_found', async () => {
    const { fetch, ctx } = graph({});
    await expect(act(cfg, now, ctx, req('delete'))).resolves.toEqual({ status: 'not_found' });
    expect(calls(fetch)).toEqual(['DELETE /v26.0/900_1_7']);
  });

  it('ban uses authorExternalId without a lookup', async () => {
    const { fetch, ctx } = graph({ 'POST /v26.0/900/blocked': () => ({ '42': true }) });
    await expect(act(cfg, now, ctx, req('ban_author', '42'))).resolves.toEqual({
      status: 'applied',
      platformActionId: '42',
    });
    expect(calls(fetch)).toEqual(['POST /v26.0/900/blocked']);
    expect(fetch.mock.calls[0]![1].body).toBe('user=42');
  });

  it('ban looks up the author when not supplied', async () => {
    const { fetch, ctx } = graph({
      'GET /v26.0/900_1_7': () => ({ id: '900_1_7', from: { id: '42' } }),
      'POST /v26.0/900/blocked': () => ({ '42': true }),
    });
    await expect(act(cfg, now, ctx, req('ban_author'))).resolves.toEqual({
      status: 'applied',
      platformActionId: '42',
    });
    expect(calls(fetch)).toEqual(['GET /v26.0/900_1_7', 'POST /v26.0/900/blocked']);
    expect((fetch.mock.calls[0]![0] as URL).searchParams.get('fields')).toBe('from{id}');
    expect(fetch.mock.calls[1]![1].body).toBe('user=42');
  });

  it('refuses to ban the page itself', async () => {
    const { fetch, ctx } = graph({
      'GET /v26.0/900_1_7': () => ({ id: '900_1_7', from: { id: '900' } }),
      'POST /v26.0/900/blocked': () => ({ '900': true }),
    });
    await expect(act(cfg, now, ctx, req('ban_author'))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'author_is_page',
    });
    expect(calls(fetch)).toEqual(['GET /v26.0/900_1_7']);
  });

  it('refuses to ban the page itself when supplied as authorExternalId', async () => {
    const { fetch, ctx } = graph({ 'POST /v26.0/900/blocked': () => ({ '900': true }) });
    await expect(act(cfg, now, ctx, req('ban_author', '900'))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'author_is_page',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses when the author is unavailable', async () => {
    const { fetch, ctx } = graph({
      'GET /v26.0/900_1_7': () => ({ id: '900_1_7' }),
      'POST /v26.0/900/blocked': () => ({}),
    });
    await expect(act(cfg, now, ctx, req('ban_author'))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'author_unavailable',
    });
    expect(calls(fetch)).toEqual(['GET /v26.0/900_1_7']);
  });

  it('rejects a hostile author id returned by the lookup before blocking', async () => {
    const { fetch, ctx } = graph({
      'GET /v26.0/900_1_7': () => ({ id: '900_1_7', from: { id: '../me' } }),
    });
    await expect(act(cfg, now, ctx, req('ban_author'))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_graph_id',
    });
    expect(calls(fetch)).toEqual(['GET /v26.0/900_1_7']);
  });

  it.each([
    [3801, 'ban_limit_reached'],
    [3802, 'reblock_too_soon'],
    [100, 'author_not_bannable'],
    [210, 'author_not_bannable'],
  ])('maps ban error %i to %s', async (code, expected) => {
    const { fetch, ctx } = failing('POST /v26.0/900/blocked', { code });
    const err = await act(cfg, now, ctx, req('ban_author', '42')).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: expected });
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('RAW-GRAPH-MESSAGE');
    expect(calls(fetch)).toEqual(['POST /v26.0/900/blocked']);
  });

  it('maps ban error 100/33 (object gone) to not_found, not author_not_bannable', async () => {
    const { ctx } = failing('POST /v26.0/900/blocked', { code: 100, error_subcode: 33 });
    await expect(act(cfg, now, ctx, req('ban_author', '42'))).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('leaves unrelated ban errors to the standard mapping', async () => {
    const { ctx } = failing('POST /v26.0/900/blocked', { code: 190, error_subcode: 463 });
    await expect(act(cfg, now, ctx, req('ban_author', '42'))).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'token_expired',
    });
  });

  it('rejects a hostile authorExternalId before any call', async () => {
    const { fetch, ctx } = graph({ 'POST /v26.0/900/blocked': () => ({ '1': true }) });
    await expect(act(cfg, now, ctx, req('ban_author', 'x/../1'))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_graph_id',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a hostile comment id before any call', async () => {
    const { fetch, ctx } = graph({});
    await expect(
      act(cfg, now, ctx, { action: 'hide', target: { ...target, externalId: '1/../me' } }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_graph_id' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a hostile page id before any call', async () => {
    const { fetch, ctx } = graph({});
    await expect(
      act(cfg, now, { ...ctx, externalAccountId: 'me' }, req('ban_author', '42')),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_graph_id' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('unban sends DELETE with user in the query', async () => {
    const { fetch, ctx } = graph({ 'DELETE /v26.0/900/blocked': () => ({ success: true }) });
    await expect(act(cfg, now, ctx, req('unban_author', '42'))).resolves.toEqual({
      status: 'applied',
      platformActionId: '42',
    });
    expect(calls(fetch)).toEqual(['DELETE /v26.0/900/blocked']);
    const [url, init] = fetch.mock.calls[0]!;
    expect((url as URL).searchParams.get('user')).toBe('42');
    expect(init.body).toBeUndefined();
  });
});

describe('respond', () => {
  it('public reply posts a message and returns the new comment id', async () => {
    const { fetch, ctx } = graph({
      'POST /v26.0/900_1_7/comments': () => ({ id: '900_1_9' }),
    });
    await expect(
      respond(cfg, now, ctx, { kind: 'public_reply', target, text: 'Thanks!' }),
    ).resolves.toEqual({ status: 'sent', platformRef: '900_1_9' });
    expect(calls(fetch)).toEqual(['POST /v26.0/900_1_7/comments']);
    const init = fetch.mock.calls[0]![1];
    expect(init.body).toBe('message=Thanks%21');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('public reply drops a returned id that is not a Graph id', async () => {
    const { ctx } = graph({ 'POST /v26.0/900_1_7/comments': () => ({ id: '../x' }) });
    await expect(
      respond(cfg, now, ctx, { kind: 'public_reply', target, text: 'Hi' }),
    ).resolves.toEqual({ status: 'sent', platformRef: null });
  });

  it('public reply on a missing comment is not_found', async () => {
    const { ctx } = graph({});
    await expect(
      respond(cfg, now, ctx, { kind: 'public_reply', target, text: 'Hi' }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('private reply posts JSON to the page messages edge', async () => {
    const { fetch, ctx } = graph({
      'POST /v26.0/900/messages': () => ({ recipient_id: '777', message_id: 'm_1' }),
    });
    await expect(
      respond(cfg, now, ctx, { kind: 'private_reply', target, text: 'DM me' }),
    ).resolves.toEqual({ status: 'sent', platformRef: 'm_1' });
    expect(calls(fetch)).toEqual(['POST /v26.0/900/messages']);
    const init = fetch.mock.calls[0]![1];
    expect(JSON.parse(String(init.body))).toEqual({
      recipient: { comment_id: '900_1_7' },
      message: { text: 'DM me' },
    });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('private reply keeps platformRef null when the message id fails externalIdSchema', async () => {
    const { ctx } = graph({
      'POST /v26.0/900/messages': () => ({ recipient_id: '777', message_id: 'm\u0000x' }),
    });
    await expect(
      respond(cfg, now, ctx, { kind: 'private_reply', target, text: 'DM me' }),
    ).resolves.toEqual({ status: 'sent', platformRef: null });
  });

  it.each(PRIVATE_REPLY_INELIGIBLE.map((x) => [x.code, x.subcode, x.reason] as const))(
    'private reply error %i/%s is not_eligible %s',
    async (code, subcode, reason) => {
      const { ctx } = failing('POST /v26.0/900/messages', {
        code,
        ...(subcode !== null ? { error_subcode: subcode } : {}),
      });
      await expect(
        respond(cfg, now, ctx, { kind: 'private_reply', target, text: 'DM me' }),
      ).resolves.toEqual({ status: 'not_eligible', code: reason });
    },
  );

  it('private reply errors outside the table are thrown, without the raw message', async () => {
    const { ctx } = failing('POST /v26.0/900/messages', { code: 10, error_subcode: 1 });
    const err = await respond(cfg, now, ctx, {
      kind: 'private_reply',
      target,
      text: 'DM me',
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'permission_denied' });
    expect(JSON.stringify(err) + (err as Error).message).not.toContain('RAW-GRAPH-MESSAGE');
  });

  it('public reply errors are never mapped to not_eligible', async () => {
    const { ctx } = failing('POST /v26.0/900_1_7/comments', { code: 10900 });
    await expect(
      respond(cfg, now, ctx, { kind: 'public_reply', target, text: 'Hi' }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'graph_error' });
  });

  it('reply text with markup is sent verbatim as form data', async () => {
    const { fetch, ctx } = graph({
      'POST /v26.0/900_1_7/comments': () => ({ id: '900_1_9' }),
    });
    await respond(cfg, now, ctx, { kind: 'public_reply', target, text: '<b>x</b>&y=1' });
    expect(fetch.mock.calls[0]![1].body).toBe('message=%3Cb%3Ex%3C%2Fb%3E%26y%3D1');
  });

  it('rejects a hostile target id before any call', async () => {
    const { fetch, ctx } = graph({});
    await expect(
      respond(cfg, now, ctx, {
        kind: 'private_reply',
        target: { ...target, externalId: '1?x=1' },
        text: 'Hi',
      }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_graph_id' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('onConnected subscribes the page to feed and reads the list back', async () => {
    let fields: string[] = [];
    const { fetch, ctx } = graph({
      'GET /v26.0/900/subscribed_apps': () => ({
        data: fields.length ? [{ id: cfg.appId, subscribed_fields: fields }] : [],
      }),
      'POST /v26.0/900/subscribed_apps': (_u, init) => {
        fields = new URLSearchParams(String(init.body)).get('subscribed_fields')!.split(',');
        return { success: true };
      },
    });
    await expect(lifecycle(cfg, now).onConnected(ctx)).resolves.toBeUndefined();
    expect(calls(fetch)).toEqual([
      'GET /v26.0/900/subscribed_apps',
      'POST /v26.0/900/subscribed_apps',
      'GET /v26.0/900/subscribed_apps',
    ]);
    expect(fetch.mock.calls[1]![1].body).toBe('subscribed_fields=feed');
  });

  it('onConnected fails loudly when success is false', async () => {
    const { ctx } = graph({
      'GET /v26.0/900/subscribed_apps': () => ({ data: [] }),
      'POST /v26.0/900/subscribed_apps': () => ({ success: false }),
    });
    await expect(lifecycle(cfg, now).onConnected(ctx)).rejects.toMatchObject({
      kind: 'transient',
      code: 'subscription_not_confirmed',
    });
  });

  it('onDisconnected deletes the subscription and treats auth/not_found errors as done', async () => {
    let subscribed = true;
    const ok = graph({
      'GET /v26.0/900/subscribed_apps': () => ({
        data: subscribed ? [{ id: cfg.appId, subscribed_fields: ['feed'] }] : [],
      }),
      'DELETE /v26.0/900/subscribed_apps': () => {
        subscribed = false;
        return { success: true };
      },
    });
    await expect(lifecycle(cfg, now).onDisconnected(ok.ctx)).resolves.toBeUndefined();
    expect(calls(ok.fetch)).toEqual([
      'GET /v26.0/900/subscribed_apps',
      'DELETE /v26.0/900/subscribed_apps',
      'GET /v26.0/900/subscribed_apps',
    ]);

    const revoked = failing('GET /v26.0/900/subscribed_apps', { code: 190 });
    await expect(lifecycle(cfg, now).onDisconnected(revoked.ctx)).resolves.toBeUndefined();

    const gone = graph({});
    await expect(lifecycle(cfg, now).onDisconnected(gone.ctx)).resolves.toBeUndefined();

    const roleLost = failing('GET /v26.0/900/subscribed_apps', { code: 200 }, 403);
    await expect(lifecycle(cfg, now).onDisconnected(roleLost.ctx)).resolves.toBeUndefined();

    const down = failing('GET /v26.0/900/subscribed_apps', { code: 2 }, 500);
    await expect(lifecycle(cfg, now).onDisconnected(down.ctx)).rejects.toMatchObject({
      kind: 'transient',
      code: 'platform_unavailable',
    });

    const unknown = failing('GET /v26.0/900/subscribed_apps', { code: 1 }, 500);
    await expect(lifecycle(cfg, now).onDisconnected(unknown.ctx)).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it('onDisconnected treats a failed DELETE like a failed read: gone access is done, other errors propagate', async () => {
    const deleteFails = (error: Record<string, unknown>, status: number) => {
      const fetch = vi.fn(async (url: URL, init: RequestInit) => {
        if (init.method === 'GET' && url.pathname === '/v26.0/900/subscribed_apps') {
          return new Response(
            JSON.stringify({ data: [{ id: cfg.appId, subscribed_fields: ['feed'] }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: { message: 'RAW-GRAPH-MESSAGE', ...error } }), {
          status,
        });
      });
      return {
        fetch,
        ctx: {
          accessToken: new Secret('PAGE-TOKEN'),
          externalAccountId: '900',
          http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
          signal: AbortSignal.timeout(1000),
          reportQuota: vi.fn(async () => undefined),
        },
      };
    };

    const revoked = deleteFails({ code: 190 }, 400);
    await expect(lifecycle(cfg, now).onDisconnected(revoked.ctx)).resolves.toBeUndefined();
    expect(calls(revoked.fetch)).toEqual([
      'GET /v26.0/900/subscribed_apps',
      'DELETE /v26.0/900/subscribed_apps',
    ]);

    const roleLost = deleteFails({ code: 200 }, 403);
    await expect(lifecycle(cfg, now).onDisconnected(roleLost.ctx)).resolves.toBeUndefined();

    const gone = deleteFails({ code: 100, error_subcode: 33 }, 404);
    await expect(lifecycle(cfg, now).onDisconnected(gone.ctx)).resolves.toBeUndefined();

    const down = deleteFails({ code: 2 }, 500);
    await expect(lifecycle(cfg, now).onDisconnected(down.ctx)).rejects.toMatchObject({
      kind: 'transient',
      code: 'platform_unavailable',
    });

    const policy = deleteFails({ code: 368 }, 400);
    await expect(lifecycle(cfg, now).onDisconnected(policy.ctx)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'blocked_for_policy',
    });
  });

  it('facebook onConnected keeps an existing instagram comments field; onDisconnected keeps it too', async () => {
    const graph = new FakeGraph({ appSecret: 'a'.repeat(32), appId: cfg.appId });
    const { userId } = graph.addUser();
    const { pageId, pageToken } = graph.addPage(userId);
    graph.setSubscription(pageId, cfg.appId, ['comments']);
    const sharedCfg = { ...cfg, appSecret: new Secret('a'.repeat(32)) };
    const ctx = {
      accessToken: new Secret(pageToken),
      externalAccountId: pageId,
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: graph.fetch }),
      signal: AbortSignal.timeout(1000),
      reportQuota: vi.fn(async () => undefined),
    };
    const lc = lifecycle(sharedCfg, now);
    await lc.onConnected(ctx);
    expect([...graph.subscribedFields(pageId)].sort()).toEqual(['comments', 'feed']);
    await lc.onDisconnected(ctx);
    expect(graph.subscribedFields(pageId)).toEqual(['comments']);
    expect(graph.subscribed(pageId)).toBe(true);
  });
});
