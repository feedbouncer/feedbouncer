import { createSafeHttp } from '@feedbouncer/connectors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TIKTOK_API_HOST, type TikTokEndpoint } from '../endpoints.js';
import { tiktokRequest } from '../request.js';
import { FakeTikTok } from './fake-tiktok.js';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const anyObj = z.custom<Obj>(() => true);

function world(o: { now?: () => Date } = {}) {
  const fake = new FakeTikTok({ appId: 'app', appSecret: 'sec', ...o });
  const http = createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch: fake.fetch });
  const call = (endpoint: TikTokEndpoint, token: string | undefined, r: Obj = {}) =>
    tiktokRequest(
      { http, signal: new AbortController().signal, ...(token && { accessToken: token }) },
      { endpoint, method: r.body ? 'POST' : 'GET', schema: anyObj, ...r },
    ).then((x) => x.data);
  const ttLogin = async () => {
    const acct = fake.addBusinessAccount({ username: 'shop' });
    const t = await call('ttToken', undefined, {
      body: {
        client_id: 'app',
        client_secret: 'sec',
        grant_type: 'authorization_code',
        auth_code: acct.authCode,
        redirect_uri: 'https://x/cb',
      },
    });
    return { ...acct, token: t.access_token as string, tokens: t };
  };
  const adLogin = async () => {
    const adv = fake.addAdvertiser({ name: 'Acme' });
    const t = await call('adOauthToken', undefined, {
      body: { app_id: 'app', secret: 'sec', auth_code: adv.authCode },
    });
    return { ...adv, token: t.access_token as string, tokens: t };
  };
  return { fake, call, ttLogin, adLogin };
}

describe('FakeTikTok', () => {
  it('authCodeFor issues a fresh single-use code; one ads code may cover many advertisers', async () => {
    const { fake, call } = world();
    const a = fake.addAdvertiser({ name: 'A' }).advertiserId;
    const b = fake.addAdvertiser({ name: 'B' }).advertiserId;
    const code = fake.authCodeFor(a, b);
    const t = await call('adOauthToken', undefined, {
      body: { app_id: 'app', secret: 'sec', auth_code: code },
    });
    expect(t.advertiser_ids).toEqual([a, b]);
    const list = await call('adAdvertiserGet', t.access_token, {
      query: { app_id: 'app', secret: 'sec' },
    });
    expect(list.list.map((x: Obj) => x.advertiser_name)).toEqual(['A', 'B']);
    await expect(
      call('adOauthToken', undefined, { body: { app_id: 'app', secret: 'sec', auth_code: code } }),
    ).rejects.toThrow();
    const { businessId } = fake.addBusinessAccount();
    const tt = await call('ttToken', undefined, {
      body: { client_id: 'app', client_secret: 'sec', auth_code: fake.authCodeFor(businessId) },
    });
    expect(tt.open_id).toBe(businessId);
  });

  it('organic comment list pages newest first with cursor and has_more', async () => {
    const { fake, call, ttLogin } = await Promise.resolve(world());
    const a = await ttLogin();
    const { itemId } = fake.addVideo(a.businessId);
    for (let i = 0; i < 45; i++) fake.addComment(itemId, { text: `c${i}`, createdAtSec: 1000 + i });
    const pages: Obj[] = [];
    let cursor = '0';
    for (;;) {
      const p = await call('businessCommentList', a.token, {
        query: { business_id: a.businessId, video_id: itemId, cursor, max_count: '20' },
      });
      pages.push(p);
      if (!p.has_more) break;
      cursor = String(p.cursor);
    }
    expect(pages.map((p) => p.comments.length)).toEqual([20, 20, 5]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    const texts = pages.flatMap((p) => p.comments.map((c: Obj) => c.text));
    expect(texts).toEqual(Array.from({ length: 45 }, (_, i) => `c${44 - i}`));
    expect(pages[0]!.comments[0]).toMatchObject({
      video_id: itemId,
      status: 'PUBLIC',
      reply_count: 0,
    });
  });

  it('ads comment list pages by number and honours the date window', async () => {
    const { fake, call, adLogin } = world();
    const a = await adLogin();
    const days = ['2026-03-01', '2026-03-02', '2026-03-03'];
    let n = 0;
    for (const d of days)
      for (let i = 0; i < (d === days[0] ? 50 : 100); i++)
        fake.addAdComment(a.advertiserId, {
          adId: 'ad1',
          itemId: 'v1',
          text: `t${n++}`,
          createdAt: new Date(
            `${d}T00:00:00Z`.replace('00:00:00', `${String(i % 24).padStart(2, '0')}:00:00`),
          ),
        });
    const q = (extra: Obj) => ({
      advertiser_id: a.advertiserId,
      start_time: '2026-03-01',
      end_time: '2026-03-03',
      sort_field: 'CREATE_TIME',
      sort_type: 'DESC',
      page_size: '100',
      ...extra,
    });
    const p1 = await call('adCommentList', a.token, { query: q({ page: '1' }) });
    expect(p1.page_info).toEqual({ page: 1, page_size: 100, total_number: 250, total_page: 3 });
    expect(p1.comments).toHaveLength(100);
    expect(p1.comments[0].create_time).toMatch(/^2026-03-03 \d\d:00:00$/);
    const p3 = await call('adCommentList', a.token, { query: q({ page: '3' }) });
    expect(p3.comments).toHaveLength(50);
    const win = await call('adCommentList', a.token, {
      query: q({ start_time: '2026-03-02', page: '1' }),
    });
    expect(win.page_info.total_number).toBe(200);
    expect(win.comments.every((c: Obj) => !c.create_time.startsWith('2026-03-01'))).toBe(true);
  });

  it('ads comment list treats comment_type ["ALL"] as every type', async () => {
    const { fake, call, adLogin } = world();
    const a = await adLogin();
    const top = fake.addAdComment(a.advertiserId, {
      adId: 'ad1',
      itemId: 'v1',
      text: 'top',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    fake.addAdComment(a.advertiserId, {
      adId: 'ad1',
      itemId: 'v1',
      text: 'reply',
      createdAt: new Date('2026-03-01T01:00:00Z'),
      parentId: top.commentId,
    });
    const r = await call('adCommentList', a.token, {
      query: { advertiser_id: a.advertiserId, comment_type: '["ALL"]' },
    });
    expect(r.comments).toHaveLength(2);
  });

  it('mutateBetweenPages lets a test delete an item mid-pass', async () => {
    const { fake, call, ttLogin } = world();
    const a = await ttLogin();
    const { itemId } = fake.addVideo(a.businessId);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++)
      ids.push(fake.addComment(itemId, { text: `c${i}`, createdAtSec: 1000 + i }).commentId);
    const list = (cursor: string) =>
      call('businessCommentList', a.token, {
        query: { business_id: a.businessId, video_id: itemId, cursor, max_count: '20' },
      });
    const p1 = await list('0');
    fake.mutateBetweenPages(() => fake.deleteComment(ids[2]!));
    const p2 = await list(String(p1.cursor));
    expect(p2.comments.map((c: Obj) => c.text)).toEqual(['c4', 'c3', 'c1', 'c0']);
    expect(fake.commentState(ids[2]!)).toBe('DELETED');
  });

  it('hide via comment/status/update flips state; delete makes later actions answer not-exist', async () => {
    const { fake, call, adLogin, ttLogin } = world();
    const a = await adLogin();
    const { commentId } = fake.addAdComment(a.advertiserId, {
      adId: 'ad1',
      itemId: 'v1',
      text: 'spam',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    });
    const upd = (operation: string) =>
      call('adCommentStatusUpdate', a.token, {
        body: { advertiser_id: a.advertiserId, comment_ids: [commentId], operation },
      });
    await upd('HIDDEN');
    expect(fake.commentState(commentId)).toBe('HIDDEN');
    await upd('PUBLIC');
    expect(fake.commentState(commentId)).toBe('PUBLIC');
    await call('adCommentPost', a.token, {
      body: {
        advertiser_id: a.advertiserId,
        comment_type: 'REPLY',
        comment_id: commentId,
        ad_id: 'ad1',
        tiktok_item_id: 'v1',
        text: 'thanks',
      },
    });
    expect(fake.replies(commentId)).toEqual([{ text: 'thanks' }]);
    await call('adCommentDelete', a.token, {
      body: { advertiser_id: a.advertiserId, comment_ids: [commentId] },
    });
    expect(fake.commentState(commentId)).toBe('DELETED');
    await expect(upd('HIDDEN')).rejects.toMatchObject({ code: 'comment_not_found' });
    const listed = await call('adCommentList', a.token, {
      query: { advertiser_id: a.advertiserId, start_time: '2026-03-01', end_time: '2026-03-01' },
    });
    expect(listed.comments).toEqual([]);

    const o = await ttLogin();
    const { itemId } = fake.addVideo(o.businessId);
    const c = fake.addComment(itemId, { text: 'hi', createdAtSec: 5 }).commentId;
    const hide = (action: string) =>
      call('businessCommentHide', o.token, {
        body: { business_id: o.businessId, video_id: itemId, comment_id: c, action },
      });
    await hide('HIDE');
    expect(fake.commentState(c)).toBe('HIDDEN');
    await hide('UNHIDE');
    expect(fake.commentState(c)).toBe('PUBLIC');
    await call('businessReplyCreate', o.token, {
      body: { business_id: o.businessId, video_id: itemId, comment_id: c, text: 'yo' },
    });
    expect(fake.replies(c)).toEqual([{ text: 'yo' }]);
    await call('businessCommentDelete', o.token, {
      body: { business_id: o.businessId, comment_id: c },
    });
    await expect(hide('HIDE')).rejects.toMatchObject({ code: 'comment_not_found' });
  });

  it('throttleNext / failNext / revokeScope / outage affect only the named endpoint, account or product', async () => {
    const { fake, call, ttLogin, adLogin } = world();
    const a = await ttLogin();
    const b = await ttLogin();
    const ad = await adLogin();
    const { itemId } = fake.addVideo(a.businessId);
    const list = (acct = a) =>
      call('businessCommentList', acct.token, {
        query: { business_id: acct.businessId, video_id: itemId },
      });
    const adList = () =>
      call('adCommentList', ad.token, { query: { advertiser_id: ad.advertiserId } });

    fake.throttleNext('businessCommentList', 1);
    await call('businessGet', a.token, { query: { business_id: a.businessId } });
    await expect(list()).rejects.toMatchObject({ code: 'throttled' });
    await expect(list()).resolves.toBeDefined();

    fake.failNext('adCommentList', { httpStatus: 503 });
    await expect(adList()).rejects.toMatchObject({ code: 'tiktok_unavailable' });
    fake.failNext('adCommentList', { code: 40002 });
    await expect(adList()).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adList()).resolves.toBeDefined();

    fake.revokeScope(a.businessId, 'businessCommentList');
    await expect(list()).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      call('businessGet', a.token, { query: { business_id: a.businessId } }),
    ).resolves.toBeDefined();
    fake.addVideo(b.businessId);
    await expect(
      call('businessVideoList', b.token, { query: { business_id: b.businessId } }),
    ).resolves.toBeDefined();

    fake.outage('marketing', true);
    await expect(adList()).rejects.toMatchObject({ code: 'tiktok_unavailable' });
    await expect(
      call('businessGet', b.token, { query: { business_id: b.businessId } }),
    ).resolves.toBeDefined();
    fake.outage('marketing', false);
    await expect(adList()).resolves.toBeDefined();
    fake.outage('accounts', true);
    await expect(adList()).resolves.toBeDefined();
    await expect(
      call('businessGet', b.token, { query: { business_id: b.businessId } }),
    ).rejects.toMatchObject({ code: 'tiktok_unavailable' });
    fake.outage('accounts', false);

    fake.expireAccessToken(ad.token);
    await expect(adList()).rejects.toMatchObject({ code: 'token_invalid' });
    expect(fake.calls('adCommentList').length).toBeGreaterThan(3);
    expect(fake.calls('businessGet')[0]).toMatchObject({
      endpoint: 'businessGet',
      query: { business_id: a.businessId },
    });
  });

  it('token exchange returns a rotating refresh token for tt_user and none for ads by default', async () => {
    const { fake, call, ttLogin, adLogin } = world();
    const a = await ttLogin();
    expect(a.tokens).toMatchObject({ open_id: a.businessId, expires_in: expect.any(Number) });
    expect(a.tokens.refresh_token).toEqual(expect.any(String));
    const r = await call('ttRefresh', undefined, {
      body: {
        client_id: 'app',
        client_secret: 'sec',
        grant_type: 'refresh_token',
        refresh_token: a.tokens.refresh_token,
      },
    });
    expect(r.refresh_token).not.toBe(a.tokens.refresh_token);
    expect(r.access_token).not.toBe(a.token);
    const again = () =>
      call('ttRefresh', undefined, {
        body: {
          client_id: 'app',
          client_secret: 'sec',
          grant_type: 'refresh_token',
          refresh_token: a.tokens.refresh_token,
        },
      });
    await expect(again()).rejects.toMatchObject({ code: 'token_invalid' });
    await expect(
      call('businessGet', a.token, { query: { business_id: a.businessId } }),
    ).rejects.toMatchObject({ code: 'token_invalid' });

    const ad = await adLogin();
    expect(ad.tokens).toEqual({ access_token: ad.token, advertiser_ids: [ad.advertiserId] });
    const got = await call('adAdvertiserGet', ad.token, {
      query: { app_id: 'app', secret: 'sec' },
    });
    expect(got.list).toEqual([{ advertiser_id: ad.advertiserId, advertiser_name: 'Acme' }]);
    await expect(
      call('adAdvertiserGet', ad.token, { query: { app_id: 'app', secret: 'nope' } }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      call('adCommentList', undefined, { query: { advertiser_id: ad.advertiserId } }),
    ).rejects.toMatchObject({ code: 'token_invalid' });
    expect(fake).toBeDefined();
  });

  it('withExpiringAdsTokens issues a 24h token with a refresh token', async () => {
    let now = new Date('2026-03-01T00:00:00Z');
    const { fake, call, adLogin } = world({ now: () => now });
    fake.withExpiringAdsTokens();
    const ad = await adLogin();
    expect(ad.tokens).toMatchObject({ expires_in: 86400, refresh_token: expect.any(String) });
    now = new Date('2026-03-02T00:00:01Z');
    const list = (t: string) =>
      call('adCommentList', t, { query: { advertiser_id: ad.advertiserId } });
    await expect(list(ad.token)).rejects.toMatchObject({ code: 'token_invalid' });
    const r = await call('adOauthRefresh', undefined, {
      body: { app_id: 'app', secret: 'sec', refresh_token: ad.tokens.refresh_token },
    });
    await expect(list(r.access_token)).resolves.toBeDefined();
  });
});
