import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

let api: TestApi;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let outsider: Awaited<ReturnType<typeof verifiedUser>>;
beforeAll(async () => {
  api = await startTestApi();
  users = await orgWithRoles(api, 'status');
  outsider = await verifiedUser(api, 'status-outsider');
});
afterAll(() => api.close());

const newOrg = (label: string) => orgWithRoles(api, label, users);
const setStatus = (orgId: string, s: string) =>
  api.pool.query('UPDATE organization SET status = $2 WHERE id = $1', [orgId, s]);
const SUSPENDED = {
  error: { code: 'organization_suspended', message: 'This organization is suspended.' },
};

describe('organization status in OrgAccessGuard', () => {
  it('member of a suspended org gets 403 organization_suspended', async () => {
    const org = await newOrg('s-member');
    await setStatus(org.orgId, 'suspended');
    const r = await api.req('GET', `/api/v1/orgs/${org.orgId}`, { cookie: org.member.cookie });
    expect(r.status).toBe(403);
    expect(r.body).toEqual(SUSPENDED);
  });

  it('non-member of a suspended org gets 404', async () => {
    const org = await newOrg('s-outsider');
    await setStatus(org.orgId, 'suspended');
    const r = await api.req('GET', `/api/v1/orgs/${org.orgId}`, { cookie: outsider.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('no cookie is still 401 unauthenticated', async () => {
    const org = await newOrg('s-anon');
    await setStatus(org.orgId, 'suspended');
    const r = await api.req('GET', `/api/v1/orgs/${org.orgId}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });

  it('status is checked before capability', async () => {
    const org = await newOrg('s-order');
    await setStatus(org.orgId, 'suspended');
    const r = await api.req('DELETE', `/api/v1/orgs/${org.orgId}`, { cookie: org.member.cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('organization_suspended');
  });

  it('in-flight session is denied on the next request and restored on reactivation', async () => {
    const org = await newOrg('s-inflight');
    const get = () => api.req('GET', `/api/v1/orgs/${org.orgId}`, { cookie: org.member.cookie });
    expect((await get()).status).toBe(200);
    await setStatus(org.orgId, 'suspended');
    const denied = await get();
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('organization_suspended');
    await setStatus(org.orgId, 'active');
    expect((await get()).status).toBe(200);
  });

  it('multi-org user keeps access to active orgs', async () => {
    const a = await newOrg('s-multi-a');
    const b = await newOrg('s-multi-b');
    await setStatus(a.orgId, 'suspended');
    const cookie = users.member.cookie;
    const ra = await api.req('GET', `/api/v1/orgs/${a.orgId}`, { cookie });
    const rb = await api.req('GET', `/api/v1/orgs/${b.orgId}`, { cookie });
    expect(ra.status).toBe(403);
    expect(ra.body.error.code).toBe('organization_suspended');
    expect(rb.status).toBe(200);
  });

  it('denials are logged', async () => {
    const org = await newOrg('s-log');
    await setStatus(org.orgId, 'suspended');
    await api.req('GET', `/api/v1/orgs/${org.orgId}`, { cookie: org.member.cookie });
    const entries = api.logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.msg === 'org.access_denied_suspended' && e.orgId === org.orgId);
    expect(entries).toEqual([
      expect.objectContaining({
        orgId: org.orgId,
        userId: org.member.userId,
        via: 'session',
        route: 'GET /api/v1/orgs/:orgId',
      }),
    ]);
  });
});
