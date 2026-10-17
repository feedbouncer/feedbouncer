import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
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
  const r = await api.deps.comments!.store.upsertFromPlatform(
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
  api = await startTestApi({ facebook: FACEBOOK });
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
      api.deps.comments!.store.upsertFromPlatform(
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
