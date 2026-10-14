import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgOAuthGrantStore } from '@feedbouncer/connectors';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { CASES, TOKEN_CASES, type IsolationFixture } from './isolation-cases.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let f: IsolationFixture;
beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
  const A = await orgWithRoles(api, 'isoA');
  const B = await orgWithRoles(api, 'isoB');
  // Each org has a connection with sync state, so the snapshots prove read routes
  // do not write it. B's is a Facebook Page with one comment.
  const connectionIds: string[] = [];
  for (const o of [A, B]) {
    const fb = o === B;
    const { rows } = await api.pool.query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
       VALUES ($1, $2, $3, $4, 'acct') RETURNING id`,
      [
        o.orgId,
        o.brandId,
        fb ? 'facebook' : 'youtube',
        fb ? `9${o.orgId.replace(/\D/g, '').slice(0, 15)}` : `ext-${o.orgId}`,
      ],
    );
    connectionIds.push(rows[0].id);
    await api.pool.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
       VALUES ($1, $2, $3, now())`,
      [rows[0].id, o.orgId, o.brandId],
    );
  }
  const bConnectionId = connectionIds[1]!;
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', '1_2') RETURNING id`,
    [B.orgId, B.brandId, bConnectionId],
  );
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, '1_2_3', 'hi', now()) RETURNING id`,
    [B.orgId, B.brandId, bConnectionId, source.rows[0].id],
  );
  const igConnection = await api.pool.query(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
     VALUES ($1, $2, 'instagram', $3, 'ig acct') RETURNING id`,
    [B.orgId, B.brandId, `17${B.orgId.replace(/\D/g, '').slice(0, 15)}`],
  );
  const grants = new PgOAuthGrantStore(api.pool, api.deps.env.encryption);
  const bGrantIds = { facebook: randomUUID(), instagram: randomUUID() };
  for (const platform of ['facebook', 'instagram'] as const) {
    await grants.save({
      id: bGrantIds[platform],
      organizationId: B.orgId,
      brandId: B.brandId,
      platform,
      initiatedByUserId: B.owner.userId,
      reconnectConnectionId: null,
      userToken: new Secret(`iso-user-token-${platform}`),
      grantedScopes: ['pages_show_list'],
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  const bGrantId = bGrantIds.facebook;
  const inv = await api.req('POST', `/api/v1/orgs/${B.orgId}/invitations`, {
    cookie: B.owner.cookie,
    body: { email: 'iso@x.test', role: 'member' },
  });
  await new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
  const link = new URL(extractFirstUrl(api.mailer.lastTo('iso@x.test')!.text)!);
  f = {
    A,
    B,
    bInvitationId: inv.body.invitation.id,
    bInvitationToken: link.searchParams.get('token')!,
    bConnectionId,
    bCommentId: comment.rows[0].id,
    bGrantId,
    bConnectionIds: { facebook: bConnectionId, instagram: igConnection.rows[0].id },
    bGrantIds,
  };
});
afterAll(() => api.close());

// Everything a request could change about an organization, including invitation
// token hashes (a renewal rotates them) and the audit trail (any write appends).
async function snapshot(orgId: string) {
  const q = (sql: string) => api.pool.query(sql, [orgId]).then((r) => r.rows);
  return {
    org: await q('SELECT name FROM organization WHERE id = $1'),
    brands: await q(
      'SELECT id, name, archived_at FROM brand WHERE organization_id = $1 ORDER BY id',
    ),
    members: await q(
      'SELECT user_id, role FROM membership WHERE organization_id = $1 ORDER BY user_id',
    ),
    invitations: await q(
      `SELECT id, email, role, status, token_hash, expires_at FROM invitation
       WHERE organization_id = $1 ORDER BY id`,
    ),
    connectionSync: await q(
      `SELECT connection_id, last_success_at, consecutive_failures FROM connection_sync
       WHERE organization_id = $1 ORDER BY connection_id`,
    ),
    connections: await q(
      'SELECT id, status, status_reason FROM connection WHERE organization_id = $1 ORDER BY id',
    ),
    comments: await q(
      'SELECT id, platform_state FROM comment WHERE organization_id = $1 ORDER BY id',
    ),
    actions: await q(
      'SELECT id, status FROM moderation_action WHERE organization_id = $1 ORDER BY id',
    ),
    grants: await q('SELECT id FROM oauth_grant WHERE organization_id = $1 ORDER BY id'),
    jobs: await q('SELECT id, state FROM job_ledger WHERE organization_id = $1 ORDER BY id'),
    audit: await q(
      `SELECT sequence, action, subject_type, subject_id, actor_user_id FROM audit_event
       WHERE organization_id = $1 ORDER BY sequence`,
    ),
  };
}

describe('A owner cannot reach B', () => {
  for (const c of CASES) {
    it(`${c.name} -> 404`, async () => {
      const beforeB = await snapshot(f.B.orgId);
      const beforeA = await snapshot(f.A.orgId);
      expect(beforeB.invitations.length).toBeGreaterThan(0);
      expect(beforeB.audit.length).toBeGreaterThan(0);
      expect(beforeB.grants).toHaveLength(2);
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { cookie: f.A.owner.cookie, body: c.body?.(f) });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      expect(await snapshot(f.B.orgId)).toEqual(beforeB);
      expect(await snapshot(f.A.orgId)).toEqual(beforeA);
    });
  }
});

describe("A owner holding B's invitation token", () => {
  for (const c of TOKEN_CASES) {
    it(`${c.name} -> ${c.status}, nothing more`, async () => {
      const beforeB = await snapshot(f.B.orgId);
      const beforeA = await snapshot(f.A.orgId);
      expect(beforeB.invitations.map((i) => i.status)).toEqual(['pending']);
      const [method, url] = c.route.split(' ');
      const r = await api.req(method!, url!, { cookie: f.A.owner.cookie, body: c.body(f) });
      expect(r.status).toBe(c.status);
      expect(r.body).toEqual(c.response);
      expect(await snapshot(f.B.orgId)).toEqual(beforeB);
      expect(await snapshot(f.A.orgId)).toEqual(beforeA);
    });
  }
});

describe('without a session', () => {
  for (const c of TOKEN_CASES) {
    it(`${c.name} -> 401`, async () => {
      const [method, url] = c.route.split(' ');
      const r = await api.req(method!, url!, { body: c.body(f) });
      expect(r.status).toBe(401);
    });
  }
  for (const c of CASES) {
    it(`${c.name} -> 401`, async () => {
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { body: c.body?.(f) });
      expect(r.status).toBe(401);
    });
  }
});

describe('backfill status', () => {
  it('never crosses organizations', async () => {
    await api.pool.query(
      `INSERT INTO connection_backfill
         (connection_id, organization_id, brand_id, run_id, status, window_start, window_end)
       VALUES ($1, $2, $3, gen_random_uuid(), 'running', now() - interval '1 day', now())`,
      [f.bConnectionId, f.B.orgId, f.B.brandId],
    );
    const own = await api.req(
      'GET',
      `/api/v1/orgs/${f.A.orgId}/brands/${f.A.brandId}/connections`,
      {
        cookie: f.A.owner.cookie,
      },
    );
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(f.bConnectionId);
    const cross = await api.req(
      'GET',
      `/api/v1/orgs/${f.B.orgId}/brands/${f.B.brandId}/connections`,
      {
        cookie: f.A.owner.cookie,
      },
    );
    expect(cross.status).toBe(404);
  });
});
