import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';
import { CASES, type IsolationFixture } from './isolation-cases.js';

let api: TestApi;
let f: IsolationFixture;
beforeAll(async () => {
  api = await startTestApi();
  const A = await orgWithRoles(api, 'isoA');
  const B = await orgWithRoles(api, 'isoB');
  const inv = await api.req('POST', `/api/v1/orgs/${B.orgId}/invitations`, {
    cookie: B.owner.cookie,
    body: { email: 'iso@x.test', role: 'member' },
  });
  f = { A, B, bInvitationId: inv.body.invitation.id };
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

describe('without a session', () => {
  for (const c of CASES) {
    it(`${c.name} -> 401`, async () => {
      const [method] = c.route.split(' ');
      const r = await api.req(method!, c.url(f), { body: c.body?.(f) });
      expect(r.status).toBe(401);
    });
  }
});
