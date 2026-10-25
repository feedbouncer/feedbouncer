import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectorError, createSafeHttp } from '@feedbouncer/connectors';
import * as z from 'zod';
import { THREADS_API_HOST, threadsRequest, type ThreadsEndpoint } from '../api.js';
import { FakeThreads } from './fake-threads.js';

const NOW = new Date('2026-10-20T12:00:00Z');

function world() {
  const fake = new FakeThreads({ appId: 'app1', appSecret: 'shh', now: () => NOW });
  const http = createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch: fake.fetch });
  const call = (accessToken?: string) => ({
    http,
    signal: AbortSignal.timeout(2000),
    ...(accessToken !== undefined && { accessToken }),
  });
  const any = z.looseObject({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = Record<string, any>;
  const req = async (
    token: string | undefined,
    endpoint: ThreadsEndpoint,
    o: {
      id?: string;
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      form?: Record<string, string>;
    } = {},
  ) =>
    (
      await threadsRequest(call(token), {
        endpoint,
        method: o.method ?? 'GET',
        schema: any,
        ...(o.id !== undefined && { id: o.id }),
        ...(o.query && { query: o.query }),
        ...(o.form && { form: o.form }),
      })
    ).data as Json;
  async function login(o?: { scopes?: string[] }) {
    const u = fake.addUser(o);
    const short = await req(undefined, 'oauthToken', {
      method: 'POST',
      form: {
        client_id: 'app1',
        client_secret: 'shh',
        code: u.authCode,
        grant_type: 'authorization_code',
      },
    });
    const long = await req(undefined, 'longLived', {
      query: {
        grant_type: 'th_exchange_token',
        client_secret: 'shh',
        access_token: short.access_token,
      },
    });
    return { ...u, token: long.access_token as string };
  }
  return { fake, req, login };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e as ConnectorError).code,
  );

describe('FakeThreads', () => {
  it('conversation pages newest first and includes nested replies', async () => {
    const { fake, req, login } = world();
    const u = await login();
    const { postId } = fake.addPost(u.userId);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      // depth 1 (0-29), depth 2 (30-44), depth 3 (45-59)
      const parent = i < 30 ? postId : i < 45 ? ids[i - 30]! : ids[i - 15]!;
      const { replyId } = fake.addReply(parent, {
        at: new Date(NOW.getTime() - 100_000 + i * 1000),
        text: `r${i}`,
      });
      ids.push(replyId);
    }
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await req(u.token, 'conversation', {
        id: postId,
        query: { fields: 'id,text,timestamp', ...(after && { after }) },
      });
      pages++;
      expect(page.data.length).toBeLessThanOrEqual(25);
      seen.push(...page.data.map((r: { text: string }) => r.text));
      after = page.paging?.cursors?.after;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(60);
    expect(seen[0]).toBe('r59');
    expect(seen[59]).toBe('r0');
    expect(await code(req(u.token, 'conversation', { id: ids[0]! }))).toBe('threads_error_100');
  });

  it('hide cascades to descendants', async () => {
    const { fake, req, login } = world();
    const u = await login();
    const { postId } = fake.addPost(u.userId);
    const a = fake.addReply(postId, { at: NOW }).replyId;
    const b = fake.addReply(a, { at: NOW }).replyId;
    const c = fake.addReply(b, { at: NOW }).replyId;
    const other = fake.addReply(postId, { at: NOW }).replyId;
    await req(u.token, 'manageReply', { id: a, method: 'POST', form: { hide: 'true' } });
    expect([a, b, c].map((i) => fake.hideStatus(i))).toEqual(['HIDDEN', 'HIDDEN', 'HIDDEN']);
    expect(fake.hideStatus(other)).toBe('NOT_HUSHED');
    // nested replies cannot be managed directly
    expect(
      await code(req(u.token, 'manageReply', { id: b, method: 'POST', form: { hide: 'false' } })),
    ).toBe('threads_error_100');
    fake.deleteReply(other);
    expect(await code(req(u.token, 'media', { id: other }))).toBe('media_not_found');
  });

  it('an edited reply shows its new text and an owner on posts', async () => {
    const { fake, req, login } = world();
    const u = await login();
    const { postId } = fake.addPost(u.userId);
    const r = fake.addReply(postId, { at: NOW, text: 'before' }).replyId;
    fake.editReply(r, 'after');
    const reply = await req(u.token, 'media', { id: r, query: { fields: 'text' } });
    expect(reply.text).toBe('after');
    const post = await req(u.token, 'media', { id: postId, query: { fields: 'id,owner' } });
    expect(post.owner.id).toBe(u.userId);
  });

  it('publishing_limit reports usage and publish fails once quota is used', async () => {
    const { fake, req, login } = world();
    const u = await login();
    const { postId } = fake.addPost(u.userId);
    const lim = async () =>
      (
        await req(u.token, 'publishingLimit', {
          id: u.userId,
          query: { fields: 'reply_quota_usage,reply_config' },
        })
      ).data[0];
    expect((await lim()).reply_quota_usage).toBe(0);
    expect((await lim()).reply_config.quota_total).toBe(1000);
    const publish = async () => {
      const c = await req(u.token, 'createContainer', {
        method: 'POST',
        form: { media_type: 'TEXT', text: 'hi', reply_to_id: postId },
      });
      return req(u.token, 'publish', { id: u.userId, method: 'POST', form: { creation_id: c.id } });
    };
    await publish();
    expect((await lim()).reply_quota_usage).toBe(1);
    expect(fake.repliesBy(u.userId)).toMatchObject([{ text: 'hi', replyToId: postId }]);
    fake.setReplyQuotaUsage(u.userId, 1000);
    expect(await code(publish())).toBe('reply_quota_exhausted');
    expect(fake.repliesBy(u.userId)).toHaveLength(1);
  });

  it('revokeToken makes every call answer 190', async () => {
    const { fake, req, login } = world();
    const u = await login();
    expect((await req(u.token, 'me')).id).toBe(u.userId);
    fake.revokeToken(u.token);
    expect(await code(req(u.token, 'me'))).toBe('token_invalid');
    expect(await code(req(u.token, 'meThreads'))).toBe('token_invalid');
    const u2 = await login();
    fake.expireAt(u2.token, new Date(NOW.getTime() - 1));
    expect(await code(req(u2.token, 'me'))).toBe('token_invalid');
  });

  it('serves debug_token scopes, token refresh and scripted failures', async () => {
    const { fake, req, login } = world();
    const u = await login({ scopes: ['threads_basic', 'threads_read_replies'] });
    const dbg = await req(u.token, 'debugToken', { query: { input_token: u.token } });
    expect(dbg.data.scopes).toEqual(['threads_basic', 'threads_read_replies']);
    const fresh = await req(undefined, 'refresh', {
      query: { grant_type: 'th_refresh_token', access_token: u.token },
    });
    expect(fresh.expires_in).toBe(5_184_000);
    expect(fresh.access_token).not.toBe(u.token);
    fake.failNext('me', { code: 4, httpStatus: 429, times: 2 });
    expect(await code(req(u.token, 'me'))).toBe('throttled');
    expect(await code(req(u.token, 'me'))).toBe('throttled');
    expect(await code(req(u.token, 'me'))).toBe('ok');
    expect(fake.calls('me')).toHaveLength(3);
    expect(fake.calls().length).toBeGreaterThan(3);
  });

  it('signedDelivery is signed with the app secret over the raw body', () => {
    const { fake } = world();
    const u = fake.addUser();
    const { postId } = fake.addPost(u.userId);
    const { replyId } = fake.addReply(postId, { at: NOW, text: 'hello' });
    const d = fake.signedDelivery({ replyId, appId: 'other-app' });
    const expected = createHmac('sha256', 'shh').update(d.rawBody).digest('hex');
    expect(d.headers['x-hub-signature-256']).toBe(`sha256=${expected}`);
    const body = JSON.parse(d.rawBody.toString('utf8'));
    expect(body.app_id).toBe('other-app');
    expect(fake.signedDelivery({ replyId }).rawBody.toString()).toContain('"app_id":"app1"');
    expect(body.topic).toBe('moderate');
    expect(body.target_id).toBe(u.userId);
    expect(body.values.field).toBe('replies');
    expect(body.values.value).toMatchObject({
      id: replyId,
      text: 'hello',
      media_type: 'TEXT_POST',
      replied_to: { id: postId },
      root_post: { id: postId, owner_id: u.userId, username: 'user1' },
    });
    expect(body.values.value.permalink).toContain(replyId);
    expect(typeof body.values.value.shortcode).toBe('string');
  });

  it('conversation and replies are newest first by default and oldest first only with reverse=false', async () => {
    const { fake, req, login } = world();
    const u = await login();
    const { postId } = fake.addPost(u.userId);
    const t = (i: number) => new Date(NOW.getTime() - 100_000 + i * 1000);
    const a = fake.addReply(postId, { at: t(1) }).replyId;
    const b = fake.addReply(postId, { at: t(2) }).replyId;
    const c = fake.addReply(postId, { at: t(3) }).replyId;
    const ids = async (endpoint: 'conversation' | 'replies', reverse?: string) =>
      (
        (
          await req(u.token, endpoint, {
            id: postId,
            query: { fields: 'id', ...(reverse !== undefined && { reverse }) },
          })
        ).data as { id: string }[]
      ).map((x) => x.id);
    for (const endpoint of ['conversation', 'replies'] as const) {
      expect(await ids(endpoint)).toEqual([c, b, a]);
      expect(await ids(endpoint, 'true')).toEqual([c, b, a]);
      expect(await ids(endpoint, 'false')).toEqual([a, b, c]);
    }
  });

  it('a new auth code signs the same user in again after a token was revoked', async () => {
    const { fake, req, login } = world();
    const u = await login();
    fake.revokeToken(u.token);
    await expect(req(u.token, 'me')).rejects.toBeInstanceOf(ConnectorError);
    const short = await req(undefined, 'oauthToken', {
      method: 'POST',
      form: {
        client_id: 'app1',
        client_secret: 'shh',
        code: fake.newAuthCode(u.userId),
        grant_type: 'authorization_code',
      },
    });
    expect(short.user_id).toBe(u.userId);
  });
});
