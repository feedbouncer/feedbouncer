import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { upsertStored } from '@feedbouncer/comments/testing';
import { runExecuteJob } from '../testing/execute.js';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const BODY = 'secret-comment-body-zq91';
const AUTHOR = 'Secret Author Zq91';

let api: TestApi;
let graph: FakeGraph;
let A: OrgFixture;
let B: OrgFixture;
let brand2: string;
let fb: Awaited<ReturnType<typeof connect>>;
let ig: Awaited<ReturnType<typeof connect>>;
let fb2: Awaited<ReturnType<typeof connect>>;
let adId: string;
const ids: Record<string, string> = {};

async function connect(org: OrgFixture, brandId: string, platform: Platform, ext: string) {
  const { scope } = await api.seedConnection(
    { orgId: org.orgId, brandId },
    { platform, externalAccountId: ext },
  );
  return { scope, connectionId: scope.connectionId };
}

let seq = 0;
async function comment(
  c: { scope: ConnectionScope; connectionId: string },
  postedAt: Date,
  o: { body?: string; source?: string } = {},
): Promise<string> {
  const n = ++seq;
  const r = await upsertStored(
    api.deps.comments!.store,
    c.scope,
    {
      externalId: `ext-${n}`,
      sourceExternalId: o.source ?? `post-${c.connectionId}`,
      parentExternalId: null,
      author: { externalId: `a-${n}`, displayName: AUTHOR, profileUrl: null },
      body: o.body ?? `comment ${n}`,
      postedAt,
      platformState: 'visible',
      permalink: null,
    },
    { ownAccountExternalId: 'own-page', syncedAt: new Date() },
  );
  return r.commentId;
}

const get = (org: OrgFixture, path: string, cookie = org.owner.cookie) =>
  api.req('GET', `/api/v1/orgs/${org.orgId}/comments${path}`, { cookie });
const idsOf = (r: { body: { items: { id: string }[] } }) => r.body.items.map((i) => i.id);

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: FACEBOOK.appSecret.reveal(), appId: FACEBOOK.appId });
  api = await startTestApi(
    { facebook: FACEBOOK, instagram: { meta: FACEBOOK } },
    { fetch: graph.fetch },
  );
  A = await orgWithRoles(api, 'ocA');
  B = await orgWithRoles(api, 'ocB');
  const created = await api.req('POST', `/api/v1/orgs/${A.orgId}/brands`, {
    cookie: A.owner.cookie,
    body: { name: 'Second brand' },
  });
  brand2 = created.body.brand.id;
  const f1 = (fb = await connect(A, A.brandId, 'facebook', '1000000000001'));
  const i1 = (ig = await connect(A, A.brandId, 'instagram', '1000000000002'));
  const f2 = (fb2 = await connect(A, brand2, 'facebook', '1000000000003'));
  const t = Date.parse('2026-10-10T10:00:00Z');
  ids.fb1 = await comment(f1, new Date(t + 1000), { body: BODY });
  ids.ig1 = await comment(i1, new Date(t + 2000));
  ids.fb2 = await comment(f2, new Date(t + 3000));
  ids.fbOld = await comment(f1, new Date(t));
  // An ad on fb1's post, a category on fb2.
  const source = await api.pool.query(`SELECT source_id FROM comment WHERE id = $1`, [ids.fb1]);
  const ad = await api.pool.query(
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
                          effective_status, active, facebook_source_external_id, facebook_resolution,
                          instagram_resolution, last_discovered_at, name)
     VALUES ($1, $2, $3, '900', '800', 'ACTIVE', true, '1_2', 'linked', 'not_instagram', now(), 'Spring sale')
     RETURNING id`,
    [A.orgId, A.brandId, f1.connectionId],
  );
  adId = ad.rows[0].id;
  await api.pool.query(
    `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
     VALUES ($1, $2, $3, $4, 'facebook')`,
    [A.orgId, A.brandId, adId, source.rows[0].source_id],
  );
  await api.pool.query(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason, category)
     VALUES ($1, $2, $3, 'approve', 'enforce', 'user', $4, 'r', 'spam')`,
    [A.orgId, brand2, ids.fb2, A.owner.userId],
  );
});
afterAll(() => api.close());

describe('GET /orgs/:orgId/comments', () => {
  it('lets member, admin and owner list; hides it from non-members; needs a session', async () => {
    for (const u of [A.member, A.admin, A.owner])
      expect((await get(A, '', u.cookie)).status).toBe(200);
    expect((await get(A, '', B.owner.cookie)).status).toBe(404);
    expect((await api.req('GET', `/api/v1/orgs/${A.orgId}/comments`)).status).toBe(401);
  });

  it('lists comments from two brands together, newest first, with the total', async () => {
    const r = await get(A, '');
    expect(idsOf(r)).toEqual([ids.fb2, ids.ig1, ids.fb1, ids.fbOld]);
    expect(r.body.total).toBe(4);
    expect(r.body.next).toBeNull();
    expect(r.body.items[0].postedAt).toBe('2026-10-10T10:00:03.000Z');
    expect(new Set(r.body.items.map((i: { brandId: string }) => i.brandId))).toEqual(
      new Set([A.brandId, brand2]),
    );
  });

  it('narrows by each filter and by a combination, echoing what applied', async () => {
    const byPlatform = await get(A, '?platform=instagram');
    expect(idsOf(byPlatform)).toEqual([ids.ig1]);
    expect(byPlatform.body.applied).toEqual({
      platform: 'instagram',
      ad: null,
      category: null,
      status: null,
      queue: 'open',
      tags: [],
      brand: null,
      from: null,
      to: null,
      signal: null,
    });
    expect(idsOf(await get(A, `?ad=${adId}`))).toEqual([ids.fb1, ids.fbOld]);
    expect(idsOf(await get(A, '?ad=none'))).toEqual([ids.fb2, ids.ig1]);
    expect(idsOf(await get(A, '?category=spam'))).toEqual([ids.fb2]);
    expect(idsOf(await get(A, '?category=_none'))).toEqual([ids.ig1, ids.fb1, ids.fbOld]);
    expect(idsOf(await get(A, '?status=reviewed'))).toEqual([ids.fb2]);
    const both = await get(A, `?platform=facebook&ad=${adId}&status=new`);
    expect(idsOf(both)).toEqual([ids.fb1, ids.fbOld]);
    expect(both.body.total).toBe(2);
    expect(idsOf(await get(A, '?platform=instagram&category=spam'))).toEqual([]);
  });

  it('spikeLink query string round-trips through the API (applied echoes)', async () => {
    await api.pool.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type,
         classifier_provider, classifier_model, reason)
       VALUES ($1, $2, $3, 'hide', 'enforce', 'classifier', 'test', 'test-model', 'seeded')`,
      [A.orgId, A.brandId, ids.ig1],
    );
    const from = '2026-10-10T10:00:00.000Z';
    const to = '2026-10-10T11:00:00.000Z';
    const r = await get(A, `?queue=all&brand=${A.brandId}&from=${from}&to=${to}&signal=negative`);
    expect(r.status).toBe(200);
    expect(idsOf(r)).toEqual([ids.ig1]);
    expect(r.body.total).toBe(1);
    expect(r.body.applied).toMatchObject({ brand: A.brandId, from, to, signal: 'negative' });
    const noSignal = await get(A, `?queue=all&brand=${A.brandId}&from=${from}&to=${to}`);
    expect(idsOf(noSignal)).toEqual([ids.ig1, ids.fb1, ids.fbOld]);
    expect(noSignal.body.applied.signal).toBeNull();
    // The second brand's comment is out of the brand filter; a foreign brand id is ignored.
    expect(idsOf(await get(A, `?queue=all&brand=${brand2}`))).toEqual([ids.fb2]);
    const foreign = await get(A, `?queue=all&brand=${B.brandId}`);
    expect(foreign.body.applied.brand).toBeNull();
    expect(foreign.body.total).toBe(4);
    for (const bad of [
      'brand=nope',
      `from=${to}&to=${from}`,
      `from=${from}&to=${from}`,
      'from=2026-10-10',
      'signal=positive',
    ])
      expect((await get(A, `?${bad}`)).status).toBe(400);
  });

  it("ad id from org B in org A's URL is ignored and returns only org A comments", async () => {
    const bConn = await connect(B, B.brandId, 'facebook', '2000000000001');
    const bComment = await comment(bConn, new Date());
    const bSource = await api.pool.query('SELECT source_id FROM comment WHERE id = $1', [bComment]);
    const bAd = await api.pool.query(
      `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
                            effective_status, active, facebook_source_external_id, facebook_resolution,
                            instagram_resolution, last_discovered_at)
       VALUES ($1, $2, $3, '901', '801', 'ACTIVE', true, '1_3', 'linked', 'not_instagram', now()) RETURNING id`,
      [B.orgId, B.brandId, bConn.connectionId],
    );
    await api.pool.query(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       VALUES ($1, $2, $3, $4, 'facebook')`,
      [B.orgId, B.brandId, bAd.rows[0].id, bSource.rows[0].source_id],
    );
    const r = await get(A, `?ad=${bAd.rows[0].id}`);
    expect(r.status).toBe(200);
    expect(r.body.applied.ad).toBeNull();
    expect(idsOf(r)).toEqual([ids.fb2, ids.ig1, ids.fb1, ids.fbOld]);
    expect(JSON.stringify(r.body)).not.toContain(bComment);
    expect(JSON.stringify(r.body)).not.toContain(bAd.rows[0].id);
  });

  it('ignores an unknown category slug', async () => {
    const r = await get(A, '?category=no_such_cat');
    expect(r.status).toBe(200);
    expect(r.body.applied.category).toBeNull();
    expect(r.body.total).toBe(4);
  });

  it.each([
    'platform=meta_ads',
    'ad=abc',
    'category=Spam!',
    'status=hidden',
    'orgId=x',
    'limit=101',
    'before=2026-10-10T10:00:00Z',
  ])('rejects malformed %s with 400', async (qs) => {
    const r = await get(A, `?${qs}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
  });

  it('pages with the cursor and keeps the filters', async () => {
    const first = await get(A, '?platform=facebook&limit=2');
    expect(idsOf(first)).toEqual([ids.fb2, ids.fb1]);
    expect(first.body.total).toBe(3);
    const { before, beforeId } = first.body.next;
    const second = await get(
      A,
      `?platform=facebook&limit=2&before=${encodeURIComponent(before)}&beforeId=${beforeId}`,
    );
    expect(idsOf(second)).toEqual([ids.fbOld]);
    expect(second.body.next).toBeNull();
    expect(second.body.applied.platform).toBe('facebook');
  });

  it('shows a platform comment once after webhook, poll and retry', async () => {
    const at = new Date('2026-10-11T10:00:00Z');
    const run = () =>
      upsertStored(
        api.deps.comments!.store,
        fb2.scope,
        {
          externalId: 'dup-1',
          sourceExternalId: 'post-dup',
          parentExternalId: null,
          author: { externalId: 'a-dup', displayName: 'Dup', profileUrl: null },
          body: 'dup',
          postedAt: at,
          platformState: 'visible',
          permalink: null,
        },
        { ownAccountExternalId: 'own-page', syncedAt: new Date() },
      );
    await run();
    await run();
    await run();
    const r = await get(A, '');
    expect(r.body.items.filter((i: { body: string }) => i.body === 'dup')).toHaveLength(1);
    expect(r.body.total).toBe(5);
  });

  it('has no comment body or author name in the logs', async () => {
    await get(A, '?platform=facebook&category=spam');
    await get(A, '/filters');
    const logs = api.logLines.join('\n');
    expect(logs).not.toContain(BODY);
    expect(logs).not.toContain(AUTHOR);
    expect(logs).toContain('org_comments.list');
    expect(logs).not.toContain('"spam"');
  });
});

describe('GET /orgs/:orgId/comments/filters', () => {
  it('returns options, accounts, last sync and whether the caller can manage connections', async () => {
    await api.pool.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
       VALUES ($1, $2, $3, '2026-10-12T08:00:00Z')`,
      [fb.connectionId, A.orgId, A.brandId],
    );
    const r = await get(A, '/filters', A.admin.cookie);
    expect(r.status).toBe(200);
    expect(r.body.options.platforms).toEqual(['facebook', 'instagram']);
    expect(r.body.options.categories).toEqual(['spam']);
    expect(r.body.options.ads.map((a: { adId: string }) => a.adId)).toEqual([adId]);
    expect(r.body.options.statuses).toEqual(['new', 'flagged', 'awaiting_action', 'reviewed']);
    expect(r.body.accounts).toHaveLength(3);
    expect(r.body.lastSyncedAt).toBe('2026-10-12T08:00:00.000Z');
    expect(r.body.canManageConnections).toBe(true);
    expect((await get(A, '/filters', A.member.cookie)).body.canManageConnections).toBe(false);
    expect((await get(A, '/filters', B.owner.cookie)).status).toBe(404);
  });

  it('reports a reconnect_required account while the others keep listing, their rows not stale', async () => {
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [ig.connectionId],
    );
    try {
      const f = await get(A, '/filters');
      const problems = f.body.accounts.filter((a: { problem: string | null }) => a.problem);
      expect(
        problems.map((a: { platform: string; problem: string }) => [a.platform, a.problem]),
      ).toEqual([['instagram', 'reconnect_required']]);
      const r = await get(A, '');
      const stale = r.body.items
        .filter((i: { stale: boolean }) => i.stale)
        .map((i: { id: string }) => i.id);
      expect(stale).toEqual([ids.ig1]);
      expect(idsOf(r)).toContain(ids.fb1);
    } finally {
      await api.pool.query(
        `UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1`,
        [ig.connectionId],
      );
    }
  });

  it('is empty for an org with no connections', async () => {
    const empty = await orgWithRoles(api, 'ocEmpty');
    const f = await get(empty, '/filters');
    expect(f.body.accounts).toEqual([]);
    expect(f.body.lastSyncedAt).toBeNull();
    const l = await get(empty, '');
    expect(l.body).toMatchObject({ items: [], total: 0, next: null });
  });
});

// Replies, done and tags, in an org of their own whose Facebook Pages live in FakeGraph.
const REPLY_SECRET = 'reply-text-zq77-never-logged';
const TAG_SECRET = 'TagName Zq77';

describe('replies, done and tags on the workspace list', () => {
  let R: OrgFixture;
  let fbUserId: string;
  let page: { pageId: string; scope: ConnectionScope };

  async function connectedPage(): Promise<{ pageId: string; scope: ConnectionScope }> {
    const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop' });
    const { scope } = await api.seedConnection(
      { orgId: R.orgId, brandId: R.brandId },
      { platform: 'facebook', externalAccountId: pageId },
    );
    await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
    return { pageId, scope };
  }

  async function fbComment(
    p: { pageId: string; scope: ConnectionScope },
    o: { message?: string } = {},
  ): Promise<{ id: string; externalId: string }> {
    const c = graph.addComment(p.pageId, { message: o.message ?? 'hello' });
    const r = await upsertStored(
      api.deps.comments!.store,
      p.scope,
      {
        externalId: c.commentId,
        sourceExternalId: c.postId,
        parentExternalId: null,
        author: { externalId: `a-${randomUUID()}`, displayName: 'Fan', profileUrl: null },
        body: o.message ?? 'hello',
        postedAt: new Date(),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: p.pageId, syncedAt: new Date() },
    );
    return { id: r.commentId, externalId: c.commentId };
  }

  const key = () => `rk-${randomUUID()}`;
  const path = (p: string) => `/api/v1/orgs/${R.orgId}${p}`;
  const reply = (commentId: string, body: unknown, cookie = R.owner.cookie) =>
    api.req('POST', path(`/comments/${commentId}/replies`), { cookie, body });
  const replies = (commentId: string, cookie = R.owner.cookie) =>
    api.req('GET', path(`/comments/${commentId}/replies`), { cookie });
  const triage = (body: unknown, cookie = R.owner.cookie) =>
    api.req('POST', path('/comments/triage'), { cookie, body });
  const list = (q = '?queue=all&limit=100', cookie = R.owner.cookie) =>
    api.req('GET', path(`/comments${q}`), { cookie });
  const row = async (id: string, cookie = R.owner.cookie) =>
    (await list('?queue=all&limit=100', cookie)).body.items.find(
      (i: { id: string }) => i.id === id,
    );
  const newTag = async (name: string) => {
    const r = await api.req('POST', path('/tags'), { cookie: R.owner.cookie, body: { name } });
    expect(r.status).toBe(201);
    return r.body.tag.id as string;
  };
  const graphReplies = (externalId: string) => graph.replies(externalId);
  const setGrant = async (granted: boolean) => {
    const r = await api.req('PUT', path('/role-grants'), {
      cookie: R.owner.cookie,
      body: { role: 'member', capability: 'comment.reply', granted },
    });
    expect(r.status).toBe(200);
  };

  beforeAll(async () => {
    R = await orgWithRoles(api, 'ocR');
    fbUserId = graph.addUser('Dana').userId;
    page = await connectedPage();
  });

  it('admin replies: 202 pending → job → GET replies applied with authorName; list row shows it in replies; audit comment.moderated', async () => {
    const c = await fbComment(page);
    const r = await reply(c.id, { requestKey: key(), text: REPLY_SECRET }, R.admin.cookie);
    expect(r.status).toBe(202);
    expect(r.body.reply).toMatchObject({
      status: 'pending',
      outcomeCode: null,
      text: REPLY_SECRET,
      actorType: 'user',
      authorName: 'Test User',
      completedAt: null,
    });
    expect(typeof r.body.reply.createdAt).toBe('string');
    await runExecuteJob(api, r.body.reply.id, page.scope);
    const got = await replies(c.id);
    expect(got.status).toBe(200);
    expect(got.body.replies).toEqual([
      expect.objectContaining({ id: r.body.reply.id, status: 'applied', authorName: 'Test User' }),
    ]);
    expect(typeof got.body.replies[0].completedAt).toBe('string');
    const listed = await row(c.id);
    expect(listed.replyCount).toBe(1);
    expect(listed.replies).toEqual([
      expect.objectContaining({ id: r.body.reply.id, status: 'applied', text: REPLY_SECRET }),
    ]);
    expect(listed).not.toHaveProperty('replyTarget');
    expect(listed.reply).toEqual({ available: true, maxChars: 8000 });
    const audit = await api.pool.query(
      `SELECT details FROM audit_event WHERE subject_id = $1 AND action = 'comment.moderated'`,
      [c.id],
    );
    expect(audit.rows.map((x) => x.details)).toEqual([
      expect.objectContaining({ kind: 'public_reply', status: 'applied' }),
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(REPLY_SECRET);
    expect(graphReplies(c.externalId).map((x) => x.message)).toEqual([REPLY_SECRET]);
  });

  it('same requestKey sent twice → one action, one Graph comment', async () => {
    const c = await fbComment(page);
    const body = { requestKey: key(), text: 'once only' };
    const first = await reply(c.id, body);
    const second = await reply(c.id, body);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body.reply.id).toBe(first.body.reply.id);
    await runExecuteJob(api, first.body.reply.id, page.scope);
    const third = await reply(c.id, body);
    expect(third.body.reply).toMatchObject({ id: first.body.reply.id, status: 'applied' });
    const rows = await api.pool.query('SELECT 1 FROM moderation_action WHERE comment_id = $1', [
      c.id,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(graphReplies(c.externalId)).toHaveLength(1);
  });

  it('same requestKey, different text → 409 request_key_conflict', async () => {
    const c = await fbComment(page);
    const k = key();
    expect((await reply(c.id, { requestKey: k, text: 'one' })).status).toBe(202);
    const r = await reply(c.id, { requestKey: k, text: 'two' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('request_key_conflict');
  });

  it('platform rejects (failNext 200 permission) → reply status failed with outcomeCode; not in list replies; a new key retries and succeeds', async () => {
    const c = await fbComment(page);
    const r = await reply(c.id, { requestKey: key(), text: 'first try' });
    graph.failNext(200);
    await runExecuteJob(api, r.body.reply.id, page.scope);
    const failed = (await replies(c.id)).body.replies[0];
    expect(failed).toMatchObject({ id: r.body.reply.id, status: 'failed' });
    expect(failed.outcomeCode).toEqual(expect.any(String));
    expect((await row(c.id)).replies).toEqual([]);
    const again = await reply(c.id, { requestKey: key(), text: 'first try' });
    expect(again.status).toBe(202);
    await runExecuteJob(api, again.body.reply.id, page.scope);
    expect((await replies(c.id)).body.replies.map((x: { status: string }) => x.status)).toEqual([
      'applied',
      'failed',
    ]);
    expect(graphReplies(c.externalId)).toHaveLength(1);
  });

  it('rate limited (throttleNext) → stays pending after attempt 1, applied after attempt 2, one Graph comment', async () => {
    // A Page of its own: the throttle blocks its budget for about a second.
    const throttled = await connectedPage();
    const c = await fbComment(throttled);
    const r = await reply(c.id, { requestKey: key(), text: 'patience' });
    graph.throttleNext(80001, 0.01);
    await expect(runExecuteJob(api, r.body.reply.id, throttled.scope)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    expect((await replies(c.id)).body.replies[0].status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await runExecuteJob(api, r.body.reply.id, throttled.scope, 'facebook', 2);
    expect((await replies(c.id)).body.replies[0].status).toBe('applied');
    expect(graphReplies(c.externalId)).toHaveLength(1);
  });

  it('comment deleted on the platform → noop comment_gone; list no longer shows it', async () => {
    const c = await fbComment(page);
    graph.removeComment(c.externalId);
    const r = await reply(c.id, { requestKey: key(), text: 'too late' });
    expect(r.status).toBe(202);
    await runExecuteJob(api, r.body.reply.id, page.scope);
    expect((await replies(c.id)).body.replies[0]).toMatchObject({
      status: 'noop',
      outcomeCode: 'comment_gone',
    });
    expect(await row(c.id)).toBeUndefined();
  });

  it('comment already deleted in our copy → 200 recorded noop already_deleted', async () => {
    const c = await fbComment(page);
    await api.pool.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c.id]);
    const r = await reply(c.id, { requestKey: key(), text: 'hello?' });
    expect(r.status).toBe(200);
    expect(r.body.reply).toMatchObject({ status: 'noop', outcomeCode: 'already_deleted' });
  });

  it('revoked page token (revokePageToken) → reply not sent, waits for reconnection; triage done still ok', async () => {
    const revoked = await connectedPage();
    const c = await fbComment(revoked);
    graph.revokePageToken(revoked.pageId);
    const r = await reply(c.id, { requestKey: key(), text: 'anyone?' });
    expect(r.status).toBe(202);
    // Facebook's 190 can be fixed by reconnecting, so the reply is held, not failed.
    await expect(runExecuteJob(api, r.body.reply.id, revoked.scope)).rejects.toMatchObject({
      kind: 'auth_expired',
    });
    expect((await replies(c.id)).body.replies[0].status).toBe('pending');
    expect(graphReplies(c.externalId)).toHaveLength(0);
    expect((await row(c.id)).reply).toEqual({
      available: false,
      reason: 'connection_needs_reconnect',
    });
    const again = await reply(c.id, { requestKey: key(), text: 'anyone?' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('connection_needs_reconnect');
    const t = await triage({ commentIds: [c.id], op: { type: 'done' } });
    expect(t.status).toBe(200);
    expect(t.body.results).toEqual([{ commentId: c.id, status: 'ok', changed: true }]);
  });

  it('connection reconnect_required → 409 connection_needs_reconnect; list row reply.available false with that reason; tag still works', async () => {
    const stale = await connectedPage();
    const c = await fbComment(stale);
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [stale.scope.connectionId],
    );
    const r = await reply(c.id, { requestKey: key(), text: 'hi' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connection_needs_reconnect');
    expect((await row(c.id)).reply).toEqual({
      available: false,
      reason: 'connection_needs_reconnect',
    });
    const tagId = await newTag('Reconnect later');
    const t = await triage({ commentIds: [c.id], op: { type: 'add_tags', tagIds: [tagId] } });
    expect(t.body.results).toEqual([{ commentId: c.id, status: 'ok', changed: true }]);
    expect((await row(c.id)).tags).toEqual([{ id: tagId, name: 'Reconnect later' }]);
  });

  it('unsupported: connector not registered → row reply.reason unsupported; POST → 422 unsupported_action', async () => {
    const c = await fbComment(page);
    const registry = api.deps.connectors!.registry;
    const original = registry.get.bind(registry);
    const spy = vi
      .spyOn(registry, 'get')
      .mockImplementation((p) => (p === 'facebook' ? undefined : original(p)));
    try {
      expect((await row(c.id)).reply).toEqual({ available: false, reason: 'unsupported' });
      const r = await reply(c.id, { requestKey: key(), text: 'hi' });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('unsupported_action');
    } finally {
      spy.mockRestore();
    }
  });

  it('empty, whitespace-only and over-limit text → 400 / 422 text_too_long {max}', async () => {
    const c = await fbComment(page);
    for (const text of ['', '   \n ', 'x'.repeat(8001)]) {
      const r = await reply(c.id, { requestKey: key(), text });
      expect(r.status, JSON.stringify(text.slice(0, 5))).toBe(400);
    }
    expect((await reply(c.id, { requestKey: key() })).status).toBe(400);
    expect((await reply(c.id, { requestKey: 'auto:x', text: 'hi' })).status).toBe(400);
    expect((await reply(c.id, { requestKey: key(), text: 'hi', kind: 'hide' })).status).toBe(400);
    const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop IG' });
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' });
    const { scope } = await api.seedConnection(
      { orgId: R.orgId, brandId: R.brandId },
      { platform: 'instagram', externalAccountId: igUserId },
    );
    await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
    const ig = graph.addIgComment(igUserId, { text: 'hello', createdAtMs: Date.now() });
    const stored = await upsertStored(
      api.deps.comments!.store,
      scope,
      {
        externalId: ig.commentId,
        sourceExternalId: ig.mediaId,
        parentExternalId: null,
        author: { externalId: '17800000001', displayName: 'ig_fan', profileUrl: null },
        body: 'hello',
        postedAt: new Date(),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: igUserId, syncedAt: new Date() },
    );
    expect((await row(stored.commentId)).reply).toEqual({ available: true, maxChars: 2200 });
    const long = await reply(stored.commentId, { requestKey: key(), text: '🙂'.repeat(2201) });
    expect(long.status).toBe(422);
    expect(long.body.error).toMatchObject({ code: 'text_too_long', max: 2200 });
    const none = await api.pool.query('SELECT 1 FROM moderation_action WHERE comment_id = $1', [
      stored.commentId,
    ]);
    expect(none.rowCount).toBe(0);
  });

  it('emoji, RTL and CJK reply text stored and returned exactly', async () => {
    const c = await fbComment(page);
    const text = 'תודה רבה 👩‍👩‍👧‍👦 شكرا 谢谢你 <b>&amp;</b>';
    const r = await reply(c.id, { requestKey: key(), text });
    expect(r.status).toBe(202);
    expect(r.body.reply.text).toBe(text);
    expect((await replies(c.id)).body.replies[0].text).toBe(text);
    expect((await row(c.id)).replies[0].text).toBe(text);
  });

  it('member without grant → POST replies 403; GET replies 200; grant revoked → 403 forbidden', async () => {
    const c = await fbComment(page);
    const denied = await reply(c.id, { requestKey: key(), text: 'hi' }, R.member.cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect((await replies(c.id, R.member.cookie)).status).toBe(200);
    expect((await row(c.id, R.member.cookie)).reply).toEqual({
      available: false,
      reason: 'not_permitted',
    });
    await setGrant(true);
    try {
      expect((await row(c.id, R.member.cookie)).reply).toEqual({ available: true, maxChars: 8000 });
      const ok = await reply(c.id, { requestKey: key(), text: 'hi' }, R.member.cookie);
      expect(ok.status).toBe(202);
    } finally {
      await setGrant(false);
    }
    const revoked = await reply(c.id, { requestKey: key(), text: 'again' }, R.member.cookie);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe('forbidden');
  });

  it('GET replies: newest first, unknown or malformed comment 404', async () => {
    const c = await fbComment(page);
    const a = await reply(c.id, { requestKey: key(), text: 'one' });
    const b = await reply(c.id, { requestKey: key(), text: 'two' });
    expect((await replies(c.id)).body.replies.map((x: { id: string }) => x.id)).toEqual([
      b.body.reply.id,
      a.body.reply.id,
    ]);
    expect((await replies(randomUUID())).status).toBe(404);
    expect((await replies('not-a-uuid')).status).toBe(404);
    expect((await reply(randomUUID(), { requestKey: key(), text: 'x' })).status).toBe(404);
  });

  it('queue default open hides done; queue=done shows; tags filter; applied echoes', async () => {
    const c1 = await fbComment(page);
    const c2 = await fbComment(page);
    expect((await triage({ commentIds: [c1.id], op: { type: 'done' } })).status).toBe(200);
    const open = await list('?limit=100');
    expect(open.body.applied).toMatchObject({ queue: 'open', tags: [] });
    expect(idsOf(open)).toContain(c2.id);
    expect(idsOf(open)).not.toContain(c1.id);
    const done = await list('?queue=done&limit=100');
    expect(idsOf(done)).toContain(c1.id);
    expect(idsOf(done)).not.toContain(c2.id);
    const doneRow = done.body.items.find((i: { id: string }) => i.id === c1.id);
    expect(doneRow.done).toEqual({ at: expect.any(String), byName: 'Test User' });
    expect(Number.isNaN(Date.parse(doneRow.done.at))).toBe(false);
    const all = await list('?queue=all&limit=100');
    expect(idsOf(all)).toEqual(expect.arrayContaining([c1.id, c2.id]));
    const t1 = await newTag('Filter one');
    const t2 = await newTag('Filter two');
    await triage({ commentIds: [c1.id, c2.id], op: { type: 'add_tags', tagIds: [t1] } });
    await triage({ commentIds: [c2.id], op: { type: 'add_tags', tagIds: [t2] } });
    const one = await list(`?queue=all&tags=${t1}`);
    expect(idsOf(one).sort()).toEqual([c1.id, c2.id].sort());
    const both = await list(`?queue=all&tags=${t1},${t2}`);
    expect(idsOf(both)).toEqual([c2.id]);
    expect(both.body.applied).toMatchObject({ queue: 'all', tags: [t1, t2] });
    expect(both.body.total).toBe(1);
  });

  it('uppercase tag ids behave like lowercase ones', async () => {
    const c = await fbComment(page);
    const tagId = await newTag('Upper case id');
    const upper = tagId.toUpperCase();
    const add = await triage({ commentIds: [c.id], op: { type: 'add_tags', tagIds: [upper] } });
    expect(add.body.results[0]).toMatchObject({ status: 'ok', changed: true });
    const again = await triage({ commentIds: [c.id], op: { type: 'add_tags', tagIds: [tagId] } });
    expect(again.body.results[0]).toMatchObject({ status: 'ok', changed: false });
    const dup = await triage({
      commentIds: [c.id],
      op: { type: 'add_tags', tagIds: [tagId, upper] },
    });
    expect(dup.status).toBe(400);
    const filtered = await list(`?queue=all&tags=${upper}`);
    expect(filtered.body.applied.tags).toEqual([tagId]);
    expect(idsOf(filtered)).toEqual([c.id]);
  });

  it('tags=<B tag id> ignored (applied.tags empty); tags=notauuid → 400', async () => {
    const bTag = await api.req('POST', `/api/v1/orgs/${B.orgId}/tags`, {
      cookie: B.owner.cookie,
      body: { name: 'B only' },
    });
    expect(bTag.status).toBe(201);
    const r = await list(`?queue=all&tags=${bTag.body.tag.id}`);
    expect(r.status).toBe(200);
    expect(r.body.applied.tags).toEqual([]);
    expect(r.body.total).toBeGreaterThan(0);
    for (const bad of ['notauuid', '-'.repeat(36), `${randomUUID()},x`, 'a,b'])
      expect((await list(`?tags=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    const eleven = Array.from({ length: 11 }, () => randomUUID()).join(',');
    expect((await list(`?tags=${eleven}`)).status).toBe(400);
    expect((await list('?queue=later')).status).toBe(400);
  });

  it('triage done/reopen/add/remove over the API, partial failure reported and successes kept', async () => {
    const c1 = await fbComment(page);
    const c2 = await fbComment(page);
    const gone = await fbComment(page);
    await api.pool.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [gone.id]);
    const missing = randomUUID();
    const done = await triage({
      commentIds: [c1.id, gone.id, missing, c2.id],
      op: { type: 'done' },
    });
    expect(done.status).toBe(200);
    expect(done.body.results).toEqual([
      { commentId: c1.id, status: 'ok', changed: true },
      { commentId: gone.id, status: 'comment_deleted', changed: false },
      { commentId: missing, status: 'not_found', changed: false },
      { commentId: c2.id, status: 'ok', changed: true },
    ]);
    const doneRows = await api.pool.query(
      'SELECT comment_id FROM comment_done WHERE comment_id = ANY($1::uuid[])',
      [[c1.id, c2.id, gone.id]],
    );
    expect(doneRows.rows.map((x) => x.comment_id).sort()).toEqual([c1.id, c2.id].sort());
    const reopen = await triage({ commentIds: [c1.id], op: { type: 'reopen' } });
    expect(reopen.body.results).toEqual([{ commentId: c1.id, status: 'ok', changed: true }]);
    const tagId = await newTag(TAG_SECRET);
    const add = await triage({ commentIds: [c1.id], op: { type: 'add_tags', tagIds: [tagId] } });
    expect(add.body.results[0]).toMatchObject({ status: 'ok', changed: true });
    expect((await row(c1.id)).tags).toEqual([{ id: tagId, name: TAG_SECRET }]);
    const remove = await triage({
      commentIds: [c1.id],
      op: { type: 'remove_tags', tagIds: [tagId] },
    });
    expect(remove.body.results[0]).toMatchObject({ status: 'ok', changed: true });
    expect((await row(c1.id)).tags).toEqual([]);
    const unknown = await triage({
      commentIds: [c1.id],
      op: { type: 'add_tags', tagIds: [randomUUID()] },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('unknown_tag');
    for (const body of [
      { commentIds: [], op: { type: 'done' } },
      { commentIds: [c1.id, c1.id], op: { type: 'done' } },
      { commentIds: Array.from({ length: 101 }, () => randomUUID()), op: { type: 'done' } },
      { commentIds: ['nope'], op: { type: 'done' } },
      { commentIds: [c1.id], op: { type: 'archive' } },
      { commentIds: [c1.id], op: { type: 'done', tagIds: [tagId] } },
      { commentIds: [c1.id], op: { type: 'add_tags', tagIds: [] } },
      { commentIds: [c1.id], op: { type: 'add_tags', tagIds: [tagId, tagId] } },
      {
        commentIds: [c1.id],
        op: { type: 'add_tags', tagIds: Array.from({ length: 11 }, () => randomUUID()) },
      },
      { commentIds: [c1.id], op: { type: 'done' }, orgId: B.orgId },
    ])
      expect((await triage(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
  });

  it("org A cannot reply to, tag or mark done B's comment; B rows unchanged", async () => {
    const bConn = await connect(B, B.brandId, 'facebook', '2000000000077');
    const bComment = await comment(bConn, new Date());
    const tagId = await newTag('Cross org');
    const r = await reply(bComment, { requestKey: key(), text: 'pwned' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect((await replies(bComment)).status).toBe(404);
    for (const op of [{ type: 'done' }, { type: 'add_tags', tagIds: [tagId] }]) {
      const t = await triage({ commentIds: [bComment], op });
      expect(t.status).toBe(200);
      expect(t.body.results).toEqual([
        { commentId: bComment, status: 'not_found', changed: false },
      ]);
    }
    const q = (sql: string) => api.pool.query(sql, [B.orgId]).then((x) => x.rows);
    expect(await q('SELECT 1 FROM comment_done WHERE organization_id = $1')).toEqual([]);
    expect(await q('SELECT 1 FROM comment_tag WHERE organization_id = $1')).toEqual([]);
    expect(
      await api.pool.query('SELECT 1 FROM moderation_action WHERE comment_id = $1', [bComment]),
    ).toMatchObject({ rowCount: 0 });
  });

  it('a comment on an archived brand is not found for reply and triage', async () => {
    const created = await api.req('POST', path('/brands'), {
      cookie: R.owner.cookie,
      body: { name: 'Archived soon' },
    });
    const brandId = created.body.brand.id as string;
    const conn = await connect(R, brandId, 'facebook', '2000000000088');
    const c = await comment(conn, new Date());
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [brandId]);
    expect((await reply(c, { requestKey: key(), text: 'hi' })).status).toBe(404);
    expect((await triage({ commentIds: [c], op: { type: 'done' } })).body.results[0].status).toBe(
      'not_found',
    );
  });

  it('filters.permissions per role and grant', async () => {
    const perms = async (cookie: string) =>
      (await api.req('GET', path('/comments/filters'), { cookie })).body.permissions;
    const all = { reply: true, triage: true, manageTags: true };
    expect(await perms(R.owner.cookie)).toEqual(all);
    expect(await perms(R.admin.cookie)).toEqual(all);
    expect(await perms(R.member.cookie)).toEqual({ reply: false, triage: true, manageTags: false });
    await setGrant(true);
    try {
      expect(await perms(R.member.cookie)).toEqual({
        reply: true,
        triage: true,
        manageTags: false,
      });
    } finally {
      await setGrant(false);
    }
    const tagId = await newTag('Shown in filters');
    const f = await api.req('GET', path('/comments/filters'), { cookie: R.member.cookie });
    expect(f.body.options.tags).toEqual(
      expect.arrayContaining([{ id: tagId, name: 'Shown in filters' }]),
    );
  });

  it('logs contain no reply text and no tag name', async () => {
    const logs = api.logLines.join('\n');
    expect(logs).toContain('org_comments.reply');
    expect(logs).toContain('tags.create');
    expect(logs).toContain('triage.apply');
    expect(logs).not.toContain(REPLY_SECRET);
    expect(logs).not.toContain(TAG_SECRET);
    expect(logs).not.toContain('Filter one');
  });
});
