import { describe, expect, it } from 'vitest';
import {
  ConnectorError,
  createSafeHttp,
  type ActionRequest,
  type CallContext,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { InstagramConfig } from './config.js';
import { act, IG_LIMITS, INSTAGRAM_PAGE_FIELDS, lifecycle, respond } from './actions.js';

const APP_SECRET = 's'.repeat(32);
const APP_ID = '1234567';
const cfg: InstagramConfig = {
  meta: {
    appId: APP_ID,
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
};
const DAY = 86_400_000;
const now = Date.now;

function world() {
  const graph = new FakeGraph({ appSecret: APP_SECRET, appId: APP_ID });
  const { userId } = graph.addUser();
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE', 'MESSAGING'] });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'brand' });
  const ctx: CallContext = {
    accessToken: new Secret(pageToken),
    externalAccountId: igUserId,
    http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: graph.fetch }),
    signal: AbortSignal.timeout(2000),
    reportQuota: async () => undefined,
  };
  const comment = (o: Parameters<FakeGraph['addIgComment']>[1] = {}) => {
    const c = graph.addIgComment(igUserId, o);
    return {
      ...c,
      target: { sourceExternalId: c.mediaId, externalId: c.commentId },
    };
  };
  return { graph, userId, pageId, pageToken, igUserId, ctx, comment };
}

const request = (
  action: ActionRequest['action'],
  target: ActionRequest['target'],
): ActionRequest => ({ action, target });

describe('instagram act', () => {
  it('hide then unhide changes state on Instagram', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    expect(await act(cfg, now)(ctx, request('hide', c.target))).toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(graph.igState(c.commentId)).toBe('hidden');
    expect(await act(cfg, now)(ctx, request('unhide', c.target))).toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(graph.igState(c.commentId)).toBe('visible');
  });

  it('sends hide as a form body on POST to the comment', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    await act(cfg, now)(ctx, request('hide', c.target));
    expect(graph.calls().at(-1)).toEqual({ method: 'POST', path: c.commentId });
  });

  it('delete removes the comment; deleting again is not_found', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    expect(await act(cfg, now)(ctx, request('delete', c.target))).toEqual({
      status: 'applied',
      platformActionId: null,
    });
    expect(graph.igState(c.commentId)).toBe('deleted');
    expect(await act(cfg, now)(ctx, request('delete', c.target))).toEqual({ status: 'not_found' });
  });

  it('hide on a comment the owner already deleted in the app is not_found', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    graph.ownerDeletes(c.commentId);
    expect(await act(cfg, now)(ctx, request('hide', c.target))).toEqual({ status: 'not_found' });
  });

  it.each(['ban_author', 'unban_author', 'report'] as const)(
    '%s is refused as unsupported without network I/O',
    async (action) => {
      const { graph, ctx, comment } = world();
      const c = comment();
      const before = graph.calls().length;
      await expect(act(cfg, now)(ctx, request(action, c.target))).rejects.toMatchObject({
        kind: 'unsupported',
        code: 'action_not_supported',
      });
      expect(graph.calls().length).toBe(before);
    },
  );

  it('hostile ids are rejected before any network call', async () => {
    const { graph, ctx } = world();
    const before = graph.calls().length;
    await expect(
      act(cfg, now)(ctx, request('hide', { sourceExternalId: '1', externalId: '../me' })),
    ).rejects.toMatchObject({ code: 'invalid_graph_id' });
    expect(graph.calls().length).toBe(before);
  });

  it('a revoked page token raises auth_expired token_expired', async () => {
    const { graph, pageId, ctx, comment } = world();
    const c = comment();
    graph.revokePageToken(pageId);
    await expect(act(cfg, now)(ctx, request('hide', c.target))).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'token_expired',
    });
  });

  it('a lost permission raises auth_expired permission_revoked', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    graph.failNext(200);
    await expect(act(cfg, now)(ctx, request('hide', c.target))).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'permission_revoked',
    });
  });

  it('throttling raises rate_limited with retryAfterMs', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    graph.throttleNext(4);
    const err = await act(cfg, now)(ctx, request('hide', c.target)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'rate_limited' });
    expect((err as ConnectorError).retryAfterMs).toBeGreaterThan(0);
  });
});

describe('instagram respond', () => {
  const pub = (target: ActionRequest['target'], text: string) =>
    ({ kind: 'public_reply', target, text }) as const;
  const priv = (target: ActionRequest['target'], text: string) =>
    ({ kind: 'private_reply', target, text }) as const;

  it('public reply is posted as the account and returns its id', async () => {
    const { graph, igUserId, ctx, comment } = world();
    const c = comment();
    const r = await respond(cfg, now)(ctx, pub(c.target, 'Thanks!'));
    expect(r).toMatchObject({ status: 'sent' });
    const replies = graph.igReplies(c.commentId);
    expect(replies).toEqual([{ id: expect.any(String), text: 'Thanks!', fromId: igUserId }]);
    expect(r).toEqual({ status: 'sent', platformRef: replies[0]!.id });
  });

  it('public reply to a nested reply lands on the top-level comment', async () => {
    const { graph, ctx, comment } = world();
    const top = comment();
    const nested = comment({ parentId: top.commentId });
    const r = await respond(cfg, now)(ctx, pub(nested.target, 'ok'));
    expect(r.status).toBe('sent');
    expect(graph.igReplies(top.commentId).map((x) => x.text)).toContain('ok');
  });

  it('public reply to a hidden comment is not_eligible reply_to_hidden_comment', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    graph.ownerHides(c.commentId);
    expect(await respond(cfg, now)(ctx, pub(c.target, 'hi'))).toEqual({
      status: 'not_eligible',
      code: 'reply_to_hidden_comment',
    });
  });

  it('public reply to a deleted comment is not_found', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    graph.ownerDeletes(c.commentId);
    expect(await respond(cfg, now)(ctx, pub(c.target, 'hi'))).toEqual({ status: 'not_found' });
  });

  it('private reply is sent once; the second is not_eligible private_reply_already_sent', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    expect(await respond(cfg, now)(ctx, priv(c.target, 'DM'))).toEqual({
      status: 'sent',
      platformRef: null,
    });
    expect(await respond(cfg, now)(ctx, priv(c.target, 'again'))).toEqual({
      status: 'not_eligible',
      code: 'private_reply_already_sent',
    });
    expect(graph.igPrivateReplies(c.commentId)).toEqual(['DM']);
  });

  it('private reply after 7 days is not_eligible private_reply_window_closed', async () => {
    const { ctx, comment } = world();
    const c = comment({ createdAtMs: Date.now() - 7 * DAY - 1000 });
    expect(await respond(cfg, now)(ctx, priv(c.target, 'DM'))).toEqual({
      status: 'not_eligible',
      code: 'private_reply_window_closed',
    });
  });

  it('private reply to a nested reply is not_eligible private_reply_nested_comment', async () => {
    const { ctx, comment } = world();
    const top = comment();
    const nested = comment({ parentId: top.commentId });
    expect(await respond(cfg, now)(ctx, priv(nested.target, 'DM'))).toEqual({
      status: 'not_eligible',
      code: 'private_reply_nested_comment',
    });
  });

  it('private reply without messaging permission is not_eligible private_reply_not_permitted', async () => {
    const { graph, userId, ctx, comment } = world();
    graph.setGrantedPermissions(userId, ['instagram_basic', 'instagram_manage_comments']);
    const c = comment();
    expect(await respond(cfg, now)(ctx, priv(c.target, 'DM'))).toEqual({
      status: 'not_eligible',
      code: 'private_reply_not_permitted',
    });
  });

  it('over-long text is not_eligible reply_too_long and nothing is sent', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    const before = graph.calls().length;
    expect(
      await respond(cfg, now)(ctx, pub(c.target, 'x'.repeat(IG_LIMITS.public_reply + 1))),
    ).toEqual({ status: 'not_eligible', code: 'reply_too_long' });
    expect(
      await respond(cfg, now)(ctx, priv(c.target, 'x'.repeat(IG_LIMITS.private_reply + 1))),
    ).toEqual({ status: 'not_eligible', code: 'reply_too_long' });
    expect(graph.calls().length).toBe(before);
  });

  it('counts code points, not UTF-16 units: 2200 emoji are accepted', async () => {
    const { graph, ctx, comment } = world();
    const c = comment();
    const text = '\u{1F600}'.repeat(2200);
    expect(text.length).toBe(4400);
    expect((await respond(cfg, now)(ctx, pub(c.target, text))).status).toBe('sent');
    expect(graph.igReplies(c.commentId)[0]!.text).toBe(text);
    expect(await respond(cfg, now)(ctx, pub(c.target, '\u{1F600}'.repeat(2201)))).toEqual({
      status: 'not_eligible',
      code: 'reply_too_long',
    });
  });

  it('the error result never contains the reply text or the token', async () => {
    const { graph, pageId, pageToken, ctx, comment } = world();
    const c = comment();
    graph.revokePageToken(pageId);
    const text = 'SECRET-REPLY-TEXT-0042';
    const err = await respond(cfg, now)(ctx, pub(c.target, text)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const e = err as ConnectorError;
    const dump = JSON.stringify({ ...e, message: e.message, stack: e.stack });
    expect(dump).not.toContain(text);
    expect(dump).not.toContain(pageToken);
    expect(dump).not.toContain(APP_SECRET);
    const text2 = 'ANOTHER-SECRET-TEXT';
    const long = await respond(cfg, now)(ctx, priv(c.target, text2.repeat(100)));
    expect(JSON.stringify(long)).not.toContain(text2);
  });
});

describe('instagram lifecycle', () => {
  it('onConnected subscribes comments on the linked page', async () => {
    const { graph, pageId, ctx } = world();
    expect(INSTAGRAM_PAGE_FIELDS).toEqual(['comments']);
    await lifecycle(cfg, now).onConnected(ctx);
    expect(graph.subscribedFields(pageId)).toEqual(['comments']);
  });

  it('instagram teardown keeps facebook feed (Review Focus 1)', async () => {
    const { graph, pageId, ctx } = world();
    graph.setSubscription(pageId, APP_ID, ['feed']);
    await lifecycle(cfg, now).onConnected(ctx);
    expect([...graph.subscribedFields(pageId)].sort()).toEqual(['comments', 'feed']);
    await lifecycle(cfg, now).onDisconnected(ctx);
    expect(graph.subscribedFields(pageId)).toEqual(['feed']);
  });

  it('onDisconnected with a revoked token resolves', async () => {
    const { graph, pageId, ctx } = world();
    await lifecycle(cfg, now).onConnected(ctx);
    graph.revokePageToken(pageId);
    await expect(lifecycle(cfg, now).onDisconnected(ctx)).resolves.toBeUndefined();
  });

  it('onConnected propagates a revoked token', async () => {
    const { graph, pageId, ctx } = world();
    graph.revokePageToken(pageId);
    await expect(lifecycle(cfg, now).onConnected(ctx)).rejects.toMatchObject({
      kind: 'auth_expired',
    });
  });
});
