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
      const parent = i < 30 || ids.length === 0 ? postId : ids[i - 30]!;
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
    expect(fake.hideStatus(other)).not.toBe('HIDDEN');
    // nested replies cannot be managed directly
    expect(
      await code(req(u.token, 'manageReply', { id: b, method: 'POST', form: { hide: 'false' } })),
    ).toBe('threads_error_100');
    fake.deleteReply(other);
    expect(await code(req(u.token, 'media', { id: other }))).toBe('media_not_found');
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
    const d = fake.signedDelivery({ replyId });
    const expected = createHmac('sha256', 'shh').update(d.rawBody).digest('hex');
    expect(d.headers['x-hub-signature-256']).toBe(`sha256=${expected}`);
    const body = JSON.parse(d.rawBody.toString('utf8'));
    expect(body.entry[0].changes[0].field).toBe('replies');
    expect(body.entry[0].changes[0].value).toMatchObject({
      id: replyId,
      text: 'hello',
      root_post: { id: postId, owner_id: u.userId },
    });
  });
});
