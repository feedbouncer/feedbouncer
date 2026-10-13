import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { CASES, TOKEN_CASES, type IsolationFixture } from './isolation-cases.js';

let api: TestApi;
let f: IsolationFixture;
beforeAll(async () => {
  api = await startTestApi();
  const A = await orgWithRoles(api, 'isoA');
  const B = await orgWithRoles(api, 'isoB');
  // Each org has a connection with sync state, so the snapshots prove read routes do not write it.
  for (const o of [A, B]) {
    const { rows } = await api.pool.query(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
       VALUES ($1, $2, 'youtube', $3, 'acct') RETURNING id`,
      [o.orgId, o.brandId, `ext-${o.orgId}`],
    );
    await api.pool.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
       VALUES ($1, $2, $3, now())`,
      [rows[0].id, o.orgId, o.brandId],
    );
  }
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
