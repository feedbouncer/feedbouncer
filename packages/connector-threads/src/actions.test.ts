import { describe, expect, it } from 'vitest';
import { createSafeHttp } from '@feedbouncer/connectors';
import { act, respond } from './actions.js';
import { THREADS_API_HOST } from './config.js';
import { FakeThreads } from './testing/fake-threads.js';

const T0 = new Date('2026-10-01T10:00:00Z');

async function world(scopes?: string[]) {
  const fake = new FakeThreads({ appId: 'app', appSecret: 'secret', now: () => T0 });
  const owner = fake.addUser({ username: 'owner', ...(scopes && { scopes }) });
  const res = await fake.fetch(`https://${THREADS_API_HOST}/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'app',
      client_secret: 'secret',
      grant_type: 'authorization_code',
      redirect_uri: 'https://x.test/cb',
      code: owner.authCode,
    }),
  });
  const { access_token } = (await res.json()) as { access_token: string };
  const call = {
    http: createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch: fake.fetch }),
    signal: AbortSignal.timeout(2000),
    accessToken: access_token,
  };
  const { postId } = fake.addPost(owner.userId);
  const { replyId } = fake.addReply(postId, { at: T0 });
  const target = { sourceExternalId: postId, externalId: replyId };
  return { fake, owner, call, target, postId };
}

describe('act', () => {
  it('hide posts hide=true to /{id}/manage_reply', async () => {
    const w = await world();
    const out = await act(w.call, { action: 'hide', target: w.target });
    expect(out).toEqual({ status: 'applied', platformActionId: null });
    const [c] = w.fake.calls('manageReply');
    expect(c!.id).toBe(w.target.externalId);
    expect(c!.form).toEqual({ hide: 'true' });
    expect(w.fake.hideStatus(w.target.externalId)).toBe('HIDDEN');
  });

  it('unhide posts hide=false', async () => {
    const w = await world();
    await act(w.call, { action: 'hide', target: w.target });
    await act(w.call, { action: 'unhide', target: w.target });
    expect(w.fake.calls('manageReply')[1]!.form).toEqual({ hide: 'false' });
    expect(w.fake.hideStatus(w.target.externalId)).toBe('UNHUSHED');
  });

  it('deleted reply → not_found', async () => {
    const w = await world();
    w.fake.deleteReply(w.target.externalId);
    expect(await act(w.call, { action: 'hide', target: w.target })).toEqual({
      status: 'not_found',
    });
  });

  it('success:false → transient/action_not_confirmed', async () => {
    const w = await world();
    const orig = w.fake.fetch;
    const http = createSafeHttp({
      allowedHosts: [THREADS_API_HOST],
      fetch: async (i, init) =>
        new URL(String(i)).pathname.endsWith('/manage_reply')
          ? Response.json({ success: false })
          : orig(i, init),
    });
    await expect(
      act({ ...w.call, http }, { action: 'hide', target: w.target }),
    ).rejects.toMatchObject({ kind: 'transient', code: 'action_not_confirmed' });
  });

  it('refuses actions other than hide and unhide', async () => {
    const w = await world();
    await expect(act(w.call, { action: 'delete', target: w.target })).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
});

describe('respond', () => {
  const text = 'thanks for the note';

  it('publishes via container then threads_publish and returns the published id', async () => {
    const w = await world();
    const out = await respond(
      { ...w.call, userId: w.owner.userId },
      { kind: 'public_reply', target: w.target, text },
    );
    const mine = w.fake.repliesBy(w.owner.userId);
    expect(mine).toHaveLength(1);
    expect(out).toEqual({ status: 'sent', platformRef: mine[0]!.id });
    expect(mine[0]).toMatchObject({ text, replyToId: w.target.externalId });
    expect(
      w.fake
        .calls()
        .map((c) => c.endpoint)
        .slice(1),
    ).toEqual(['publishingLimit', 'createContainer', 'publish']);
    const [create, publish] = [w.fake.calls('createContainer')[0], w.fake.calls('publish')[0]];
    expect(create!.form).toMatchObject({
      media_type: 'TEXT',
      text,
      reply_to_id: w.target.externalId,
    });
    expect(publish!.id).toBe(w.owner.userId);
    expect(publish!.form.creation_id).toBeDefined();
  });

  it('quota used 1000/1000 → rate_limited/reply_quota_exhausted with no container created', async () => {
    const w = await world();
    w.fake.setReplyQuotaUsage(w.owner.userId, 1000);
    await expect(
      respond(
        { ...w.call, userId: w.owner.userId },
        { kind: 'public_reply', target: w.target, text },
      ),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      code: 'reply_quota_exhausted',
      retryAfterMs: 900_000,
    });
    expect(w.fake.calls('createContainer')).toHaveLength(0);
  });

  it('publish-time code 4/2207051 → reply_quota_exhausted', async () => {
    const w = await world();
    w.fake.failNext('publish', { httpStatus: 400, code: 4, subcode: 2207051 });
    await expect(
      respond(
        { ...w.call, userId: w.owner.userId },
        { kind: 'public_reply', target: w.target, text },
      ),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      code: 'reply_quota_exhausted',
      retryAfterMs: 900_000,
    });
  });

  it('declined threads_content_publish → missing_permission with that scope', async () => {
    const w = await world(['threads_basic', 'threads_read_replies', 'threads_manage_replies']);
    await expect(
      respond(
        { ...w.call, userId: w.owner.userId },
        { kind: 'public_reply', target: w.target, text },
      ),
    ).rejects.toMatchObject({
      kind: 'permanent',
      code: 'missing_permission',
      missingScopes: ['threads_content_publish'],
    });
  });

  it('a reply that vanished → not_found', async () => {
    const w = await world();
    w.fake.deleteReply(w.target.externalId);
    expect(
      await respond(
        { ...w.call, userId: w.owner.userId },
        { kind: 'public_reply', target: w.target, text },
      ),
    ).toEqual({ status: 'not_found' });
  });

  it('refuses private replies', async () => {
    const w = await world();
    await expect(
      respond(
        { ...w.call, userId: w.owner.userId },
        { kind: 'private_reply', target: w.target, text },
      ),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
