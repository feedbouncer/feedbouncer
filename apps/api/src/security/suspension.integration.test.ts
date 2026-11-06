import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { PgApiKeys } from '@feedbouncer/public-api';
import { Secret } from '@feedbouncer/service-runtime';
import { startTestApi, verifiedUser, type TestApi } from '../testing/harness.js';
import { ACCOUNT_ROUTES, CASES, type IsolationFixture } from './isolation-cases.js';
import { buildIsolationFixture } from './isolation-fixture.js';
import { nestHandlers } from './nest-handlers.js';
import { ACCOUNT_ROUTE_SUSPENSION } from './suspension-cases.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const TIKTOK = { appId: '7300000000000001', appSecret: new Secret('tiktok-app-secret-0123456789') };
const THREADS = {
  appId: '2220001112223334',
  appSecret: new Secret('threads-app-secret-0123456789'),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};
/** The one /v1 route that needs no key. */
const PUBLIC_SPEC = 'GET /v1/openapi.json';
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const SUSPENDED = { error: { code: 'organization_suspended', message: expect.any(String) } };

let api: TestApi;
let f: IsolationFixture;
beforeAll(async () => {
  api = await startTestApi(
    {
      facebook: FACEBOOK,
      instagram: { meta: FACEBOOK },
      tiktok: TIKTOK,
      tiktokAds: TIKTOK,
      threads: THREADS,
      alerts: { slack: true, email: true, capPerHour: 30, emailPerMinute: 60 },
      trustProxyHops: 1,
    },
    { fetch: () => Promise.reject(new Error('no platform call expected')) },
  );
  f = await buildIsolationFixture(api);
});
afterAll(() => api.close());

const setStatus = (orgId: string, status: 'active' | 'suspended') =>
  api.pool.query('UPDATE organization SET status = $2 WHERE id = $1', [orgId, status]);

describe('suspension of account routes', () => {
  it('every account route has a suspension disposition', () => {
    expect(Object.keys(ACCOUNT_ROUTE_SUSPENSION).sort()).toEqual([...ACCOUNT_ROUTES].sort());
  });

  it('/me and /orgs list a suspended organization with its status', async () => {
    const org = f.B;
    await setStatus(org.orgId, 'suspended');
    try {
      const me = await api.req('GET', '/api/v1/me', { cookie: org.owner.cookie });
      expect(me.body.memberships).toContainEqual({
        organizationId: org.orgId,
        organizationName: 'isoB Org',
        role: 'owner',
        organizationStatus: 'suspended',
      });
      const orgs = await api.req('GET', '/api/v1/orgs', { cookie: org.owner.cookie });
      expect(
        orgs.body.organizations.find(
          (o: { organization: { id: string } }) => o.organization.id === org.orgId,
        ).organization.status,
      ).toBe('suspended');
    } finally {
      await setStatus(org.orgId, 'active');
    }
  });

  it("hidden-today excludes a suspended organization's items and keeps an active one's", async () => {
    // B's owner also moderates in A, which has one hide of its own.
    await api.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'admin')",
      [f.A.orgId, f.B.owner.userId],
    );
    const { scope } = await api.seedFacebookConnection(f.A);
    await api.pool.query('UPDATE connection SET granted_scopes = $2 WHERE id = $1', [
      scope.connectionId,
      ['pages_manage_engagement'],
    ]);
    const source = await api.pool.query(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1, $2, $3, 'organic_post', '1_77') RETURNING id`,
      [f.A.orgId, f.A.brandId, scope.connectionId],
    );
    const comment = await api.pool.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                            platform_state, posted_at)
       VALUES ($1, $2, $3, $4, '1_77_1', 'hi', 'hidden', now()) RETURNING id`,
      [f.A.orgId, f.A.brandId, scope.connectionId, source.rows[0].id],
    );
    const aHide = await api.pool.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'user', $5, 'susp-a-hide', 'applied', now()) RETURNING id`,
      [f.A.orgId, f.A.brandId, scope.connectionId, comment.rows[0].id, f.B.owner.userId],
    );
    const hidden = async () =>
      (
        await api.req('GET', '/api/v1/me/hidden-today?limit=100', { cookie: f.B.owner.cookie })
      ).body.items.map((i: { hideActionId: string }) => i.hideActionId);
    expect(await hidden()).toEqual(expect.arrayContaining([f.bHideActionId, aHide.rows[0].id]));
    await setStatus(f.B.orgId, 'suspended');
    try {
      const after = await hidden();
      expect(after).toContain(aHide.rows[0].id);
      expect(after).not.toContain(f.bHideActionId);
    } finally {
      await setStatus(f.B.orgId, 'active');
    }
  });

  it('report subscription PUT is 403 organization_suspended for a member, not_found for a non-member', async () => {
    await setStatus(f.B.orgId, 'suspended');
    try {
      const url = `/api/v1/me/report-subscriptions/${f.B.orgId}`;
      const admin = await api.req('PUT', url, {
        cookie: f.B.admin.cookie,
        body: { subscribed: false },
      });
      expect([admin.status, admin.body]).toEqual([403, SUSPENDED]);
      const outsider = await api.req('PUT', url, {
        cookie: f.A.owner.cookie,
        body: { subscribed: false },
      });
      expect([outsider.status, outsider.body.error.code]).toEqual([404, 'not_found']);
    } finally {
      await setStatus(f.B.orgId, 'active');
    }
  });

  it('accepting a valid invitation to a suspended organization is denied and joins nobody', async () => {
    const invitee = await verifiedUser(api, 'susp-invitee');
    const sent = await api.req('POST', `/api/v1/orgs/${f.B.orgId}/invitations`, {
      cookie: f.B.owner.cookie,
      body: { email: invitee.email, role: 'member' },
    });
    expect(sent.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
    const token = new URL(
      extractFirstUrl(api.mailer.lastTo(invitee.email)!.text)!,
    ).searchParams.get('token')!;
    const accept = (t: string) =>
      api.req('POST', '/api/v1/invitations/accept', { cookie: invitee.cookie, body: { token: t } });
    const members = async () =>
      (
        await api.pool.query(
          'SELECT 1 FROM membership WHERE organization_id = $1 AND user_id = $2',
          [f.B.orgId, invitee.userId],
        )
      ).rowCount;

    await setStatus(f.B.orgId, 'suspended');
    try {
      const denied = await accept(token);
      expect([denied.status, denied.body]).toEqual([403, SUSPENDED]);
      expect(await members()).toBe(0);
      const invalid = await accept('not-a-real-token');
      expect([invalid.status, invalid.body.error.code]).toEqual([404, 'not_found']);
    } finally {
      await setStatus(f.B.orgId, 'active');
    }
    const ok = await accept(token);
    expect(ok.status).toBe(200);
    expect(await members()).toBe(1);
  });
});

describe('suspension sweeps', () => {
  it('every tenant route answers 403 organization_suspended to a member of a suspended org', async () => {
    // The isolation cases aim A's path at B's resources; swapping A and B puts B's own
    // path on them. Cases already on B's path (no ids to cross) are used as they are.
    const g = { ...f, A: f.B, B: f.A };
    const onB = (u: string) => u.includes(`/orgs/${f.B.orgId}`);
    const cases = CASES.map((c) => (onB(c.url(f)) ? { c, fx: f } : { c, fx: g }));
    expect(cases.every(({ c, fx }) => onB(c.url(fx)))).toBe(true);
    await setStatus(f.B.orgId, 'suspended');
    try {
      for (const { c, fx } of cases) {
        const [method] = c.route.split(' ');
        const r = await api.req(method!, c.url(fx), {
          cookie: f.B.owner.cookie,
          body: c.body?.(fx),
        });
        expect([c.name, r.status, r.body?.error?.code]).toEqual([
          c.name,
          403,
          'organization_suspended',
        ]);
      }
    } finally {
      await setStatus(f.B.orgId, 'active');
    }
  });

  it('every /v1 route answers 403 organization_suspended to a key of a suspended org', async () => {
    const { token } = await new PgApiKeys(api.pool).create(f.B.orgId, f.B.owner.userId, {
      name: 'sweep',
      scope: 'write',
    });
    const routes = nestHandlers(api.app)
      .map((h) => h.route)
      .filter((r) => r.split(' ')[1]!.startsWith('/v1/') && r !== PUBLIC_SPEC);
    expect(routes.length).toBeGreaterThan(0);
    await setStatus(f.B.orgId, 'suspended');
    try {
      for (const route of routes) {
        const [method, path] = route.split(' ') as [string, string];
        const r = await api.req(method, path.replace(/:\w+/g, ZERO_UUID), {
          body: method === 'GET' ? undefined : {},
          headers: {
            authorization: `Bearer ${token.reveal()}`,
            'x-forwarded-for': `198.51.100.${(routes.indexOf(route) % 250) + 1}`,
          },
        });
        expect([route, r.status, r.body?.error?.code]).toEqual([
          route,
          403,
          'organization_suspended',
        ]);
      }
    } finally {
      await setStatus(f.B.orgId, 'active');
    }
  });
});
