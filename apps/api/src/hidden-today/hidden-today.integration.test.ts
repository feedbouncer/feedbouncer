// The account-wide "Hidden today" list, the single-row read and one-click unhide over the API.
// Platform calls are not made: the unhide only reaches the job queue, so the tests settle the
// action rows themselves where the worker would.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const SCOPE = 'pages_manage_engagement';
const BODY = 'zq-secret-comment-body';

let api: TestApi;
let shared: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let seq = 0;

beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
  const first = await orgWithRoles(api, 'ht');
  shared = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

type Org = { orgId: string; brandId: string };
const connections = new Map<string, string>();

async function connectionOf(o: Org): Promise<string> {
  let id = connections.get(o.brandId);
  if (!id) {
    id = (await api.seedFacebookConnection(o)).scope.connectionId;
    await api.pool.query('UPDATE connection SET granted_scopes = $2 WHERE id = $1', [id, [SCOPE]]);
    connections.set(o.brandId, id);
  }
  return id;
}

/** A comment hidden by `userId`, `agoSec` seconds ago (applied, as the worker would leave it). */
async function seedHide(o: Org, userId: string, agoSec = 10): Promise<string> {
  const connectionId = await connectionOf(o);
  const n = ++seq;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [o.orgId, o.brandId, connectionId, `1_${n}`],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          platform_state, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'hidden', now()) RETURNING id`,
    [o.orgId, o.brandId, connectionId, source.rows[0].id, `1_${n}_1`, BODY],
  );
  const hide = await api.pool.query(
    `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                    actor_type, actor_user_id, request_key, status, completed_at)
     VALUES ($1, $2, $3, $4, 'hide', 'user', $5, $6, 'applied', now() - make_interval(secs => $7))
     RETURNING id`,
    [o.orgId, o.brandId, connectionId, comment.rows[0].id, userId, `seed:${randomUUID()}`, agoSec],
  );
  return hide.rows[0].id;
}

const LIST = '/api/v1/me/hidden-today';
const rowUrl = (o: Org, hideId: string) =>
  `/api/v1/orgs/${o.orgId}/brands/${o.brandId}/hidden-comments/${hideId}`;
const list = (cookie: string, qs = '') => api.req('GET', `${LIST}${qs}`, { cookie });
const ids = (r: { body: { items: { hideActionId: string }[] } }) =>
  r.body.items.map((i) => i.hideActionId);
const unhidesOf = async (hideId: string) =>
  (
    await api.pool.query(
      "SELECT id, status FROM moderation_action WHERE kind = 'unhide' AND reverses_action_id = $1",
      [hideId],
    )
  ).rows;

/** What the worker does when the platform call succeeds. */
async function settleUnhide(hideId: string) {
  await api.pool.query(
    `UPDATE moderation_action SET status = 'applied', completed_at = now()
      WHERE kind = 'unhide' AND reverses_action_id = $1`,
    [hideId],
  );
  await api.pool.query(
    `UPDATE comment SET platform_state = 'visible'
      WHERE id = (SELECT comment_id FROM moderation_action WHERE id = $1)`,
    [hideId],
  );
}

describe('GET /me/hidden-today', () => {
  it("user in orgs A and C sees both orgs' hides interleaved newest first", async () => {
    const a = await orgWithRoles(api, 'htA', shared);
    const c = await orgWithRoles(api, 'htC', shared);
    const u = shared.owner.userId;
    const a1 = await seedHide(a, u, 30);
    const c1 = await seedHide(c, u, 20);
    const a2 = await seedHide(a, u, 10);
    const r = await list(shared.owner.cookie, '?limit=100');
    expect(r.status).toBe(200);
    const mine = new Set([a1, c1, a2]);
    expect(ids(r).filter((id) => mine.has(id))).toEqual([a2, c1, a1]);
    const first = r.body.items.find((i: { hideActionId: string }) => i.hideActionId === a2);
    expect(first).toMatchObject({
      organizationId: a.orgId,
      brandId: a.brandId,
      commentBody: BODY,
      state: 'hidden',
      canUnhide: true,
      platform: 'facebook',
      source: { type: 'person', userName: expect.any(String) },
    });
    expect(first.hiddenAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/));
    expect(r.body.brands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: a.orgId,
          brandId: a.brandId,
          timezone: 'UTC',
          timezoneSet: false,
          dayStart: expect.any(String),
        }),
      ]),
    );
    expect(api.logLines.join('\n')).not.toContain(BODY);
  });

  it('user removed from org A no longer sees A rows; unhide on an A hide -> 404', async () => {
    const x = await orgWithRoles(api, 'htX', shared);
    const y = await orgWithRoles(api, 'htY', shared);
    const hx = await seedHide(x, shared.admin.userId);
    const hy = await seedHide(y, shared.admin.userId);
    const cookie = shared.admin.cookie;
    expect(ids(await list(cookie, '?limit=100'))).toEqual(expect.arrayContaining([hx, hy]));
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      x.orgId,
      shared.admin.userId,
    ]);
    const after = ids(await list(cookie, '?limit=100'));
    expect(after).toContain(hy);
    expect(after).not.toContain(hx);
    const r = await api.req('POST', `${rowUrl(x, hx)}/unhide`, { cookie, body: {} });
    expect(r.status).toBe(404);
    expect(await unhidesOf(hx)).toEqual([]);
    expect((await api.req('GET', rowUrl(x, hx), { cookie })).status).toBe(404);
  });

  it('user never sees org B rows even when passing ?orgId=', async () => {
    const b = await orgWithRoles(api, 'htB');
    const hb = await seedHide(b, b.owner.userId);
    const mine = await list(shared.owner.cookie, '?limit=100');
    expect(ids(mine)).not.toContain(hb);
    expect(JSON.stringify(mine.body)).not.toContain(b.orgId);
    for (const qs of [`?orgId=${b.orgId}`, `?brandId=${b.brandId}`]) {
      const r = await list(shared.owner.cookie, qs);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
  });

  it('cursor round-trip returns the next page; before without beforeId -> 400', async () => {
    const o = await orgWithRoles(api, 'htCur');
    const u = o.owner.userId;
    const h = [await seedHide(o, u, 30), await seedHide(o, u, 20), await seedHide(o, u, 10)];
    const p1 = await list(o.owner.cookie, '?limit=2');
    expect(ids(p1)).toEqual([h[2], h[1]]);
    expect(p1.body.next).toEqual({ before: expect.any(String), beforeId: h[1] });
    const q = new URLSearchParams({ limit: '2', ...p1.body.next });
    const p2 = await list(o.owner.cookie, `?${q}`);
    expect(ids(p2)).toEqual([h[0]]);
    expect(p2.body.next).toBeNull();
    const bad = await list(o.owner.cookie, `?before=${encodeURIComponent(p1.body.next.before)}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    expect((await list(o.owner.cookie, `?beforeId=${h[0]}`)).status).toBe(400);
  });

  it('limit=101 -> 400, as are limit=0 and a malformed cursor', async () => {
    for (const qs of ['?limit=101', '?limit=0', '?before=yesterday&beforeId=nope']) {
      expect((await list(shared.owner.cookie, qs)).status, qs).toBe(400);
    }
  });

  it('without a session -> 401', async () => {
    expect((await api.req('GET', LIST)).status).toBe(401);
  });
});

describe('Meta not configured', () => {
  it('lists no items but still the brands', async () => {
    const bare = await startTestApi();
    try {
      const o = await orgWithRoles(bare, 'htBare');
      const r = await bare.req('GET', LIST, { cookie: o.owner.cookie });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ items: [], next: null });
      expect(r.body.brands).toHaveLength(1);
      const u = await bare.req('POST', `${rowUrl(o, randomUUID())}/unhide`, {
        cookie: o.owner.cookie,
        body: {},
      });
      expect(u.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('unhide', () => {
  it('is 202 while pending, 200 with state restored after the worker runs', async () => {
    const o = await orgWithRoles(api, 'htU1', shared);
    const hide = await seedHide(o, shared.owner.userId);
    const cookie = shared.member.cookie;
    const pending = await api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} });
    expect(pending.status).toBe(202);
    expect(pending.body.item).toMatchObject({ hideActionId: hide, state: 'pending' });
    expect(pending.body.item.canUnhide).toBe(false);
    const polled = await api.req('GET', rowUrl(o, hide), { cookie });
    expect(polled.status).toBe(200);
    expect(polled.body.item.state).toBe('pending');
    await settleUnhide(hide);
    const done = await api.req('GET', rowUrl(o, hide), { cookie });
    expect(done.body.item.state).toBe('restored');
    const again = await api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} });
    expect(again.status).toBe(200);
    expect(again.body.item.state).toBe('restored');
    expect(await unhidesOf(hide)).toHaveLength(1);
    expect(api.logLines.join('\n')).not.toContain(BODY);
  });

  it('twice -> one moderation_action', async () => {
    const o = await orgWithRoles(api, 'htU2', shared);
    const hide = await seedHide(o, shared.owner.userId);
    const cookie = shared.owner.cookie;
    const [r1, r2] = await Promise.all([
      api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} }),
      api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([202, 202]);
    expect(await unhidesOf(hide)).toHaveLength(1);
  });

  it('with reconnect_required -> 409 connection_needs_reconnect; revoked -> connection_inactive', async () => {
    const o = await orgWithRoles(api, 'htU3', shared);
    const hide = await seedHide(o, shared.owner.userId);
    const cookie = shared.owner.cookie;
    const set = (status: string) =>
      api.pool.query('UPDATE connection SET status = $2 WHERE id = $1', [
        connections.get(o.brandId),
        status,
      ]);
    await set('reconnect_required');
    const r = await api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connection_needs_reconnect');
    await set('revoked');
    const g = await api.req('POST', `${rowUrl(o, hide)}/unhide`, { cookie, body: {} });
    expect(g.status).toBe(409);
    expect(g.body.error.code).toBe('connection_inactive');
    expect(await unhidesOf(hide)).toEqual([]);
  });

  it('missing scope -> 409 missing_permission with the permission', async () => {
    const o = await orgWithRoles(api, 'htU4', shared);
    const hide = await seedHide(o, shared.owner.userId);
    await api.pool.query("UPDATE connection SET granted_scopes = '{}' WHERE id = $1", [
      connections.get(o.brandId),
    ]);
    const r = await api.req('POST', `${rowUrl(o, hide)}/unhide`, {
      cookie: shared.owner.cookie,
      body: {},
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'missing_permission', permission: SCOPE });
    expect(await unhidesOf(hide)).toEqual([]);
  });

  it('body with requestKey -> 400 (strict)', async () => {
    const o = await orgWithRoles(api, 'htU5', shared);
    const hide = await seedHide(o, shared.owner.userId);
    const r = await api.req('POST', `${rowUrl(o, hide)}/unhide`, {
      cookie: shared.owner.cookie,
      body: { requestKey: 'unhide:mine' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_request');
    expect(await unhidesOf(hide)).toEqual([]);
  });

  it('unknown and malformed ids -> 404', async () => {
    const o = await orgWithRoles(api, 'htU6', shared);
    const cookie = shared.owner.cookie;
    const url = `/api/v1/orgs/${o.orgId}/brands/${o.brandId}/hidden-comments`;
    expect(
      (await api.req('POST', `${url}/${randomUUID()}/unhide`, { cookie, body: {} })).status,
    ).toBe(404);
    expect((await api.req('POST', `${url}/nope/unhide`, { cookie, body: {} })).status).toBe(404);
    expect((await api.req('GET', `${url}/${randomUUID()}`, { cookie })).status).toBe(404);
  });

  it('without a session -> 401; foreign Origin -> 403', async () => {
    const o = await orgWithRoles(api, 'htU7', shared);
    const hide = await seedHide(o, shared.owner.userId);
    const url = `${rowUrl(o, hide)}/unhide`;
    expect((await api.req('POST', url, { body: {} })).status).toBe(401);
    const foreign = await api.req('POST', url, {
      cookie: shared.owner.cookie,
      body: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(await unhidesOf(hide)).toEqual([]);
  });
});
