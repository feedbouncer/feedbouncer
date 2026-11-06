import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys } from '@feedbouncer/public-api';
import {
  PASSWORD,
  login,
  orgWithRoles,
  provisioningCredential,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

const cred = provisioningCredential();

let api: TestApi;
let keys: PgApiKeys;
let org: OrgFixture;
beforeAll(async () => {
  api = await startTestApi({
    trustProxyHops: 1,
    provisioning: { credentialDigests: [Buffer.from(cred.digestHex, 'hex')] },
  });
  keys = new PgApiKeys(api.pool);
  org = await orgWithRoles(api, 'pst');
});
afterAll(() => api.close());

let seq = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const prov = (method: string, url: string, body?: unknown) =>
  api.req(method, `/provisioning/v1/${url}`, {
    body,
    headers: { origin: '', authorization: `Bearer ${cred.token}` },
  });
const setOrg = (id: string, status: string, reason?: string) =>
  prov('PUT', `organizations/${id}/status`, { status, ...(reason && { reason }) });
const setUser = (id: string, status: string) => prov('PUT', `users/${id}/status`, { status });
const orgStatus = async (id: string) =>
  (await prov('GET', `organizations/${id}`)).body.organization.status as string;

const signIn = (email: string) =>
  api.req('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
const orgPage = (orgId: string, cookie: string) =>
  api.req('GET', `/api/v1/orgs/${orgId}`, { cookie });
const newKey = async (orgId: string, creator: TestUser) =>
  (await keys.create(orgId, creator.userId, { name: `k${++seq}`, scope: 'read' })).token.reveal();
const list = (token: string) =>
  api.req('GET', '/v1/comments', {
    headers: { 'x-forwarded-for': `198.51.100.${++seq % 250}`, authorization: `Bearer ${token}` },
  });

const count = async (sql: string, params: unknown[]) =>
  Number((await api.pool.query<{ n: string }>(sql, params)).rows[0]!.n);
const orgAudits = (orgId: string) =>
  api.pool
    .query(
      `SELECT actor_type, actor_user_id, action, details, sequence FROM audit_event
        WHERE organization_id = $1 AND action IN ('organization.suspended', 'organization.reactivated')
        ORDER BY sequence`,
      [orgId],
    )
    .then((r) => r.rows);
const lastProvisioningAudit = () =>
  api.pool
    .query(
      `SELECT credential_fingerprint, action, outcome, target_type, target_id, details
         FROM provisioning_audit_event ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .then((r) => r.rows[0]);

async function provisionedOrg(): Promise<string> {
  const r = await prov('POST', 'organizations', { externalRef: `org-${randomUUID()}`, name: 'P' });
  expect(r.status).toBe(201);
  return r.body.organization.id as string;
}
const provisionUser = (orgId: string) =>
  prov('POST', `organizations/${orgId}/users`, {
    externalRef: `user-${randomUUID()}`,
    email: `${randomUUID().slice(0, 8)}@example.com`,
    name: 'Pat',
    role: 'owner',
    sendSetupEmail: false,
  });

describe('provisioning status changes', () => {
  it('deactivating an org blocks its users and keys on the next request; reactivating restores them', async () => {
    const token = await newKey(org.orgId, org.owner);
    const rows = async () =>
      Promise.all(
        ['brand', 'connection', 'api_key'].map((t) =>
          count(`SELECT count(*) AS n FROM ${t} WHERE organization_id = $1`, [org.orgId]),
        ),
      );
    const before = await rows();
    expect([
      (await orgPage(org.orgId, org.owner.cookie)).status,
      (await list(token)).status,
    ]).toEqual([200, 200]);
    expect(await orgStatus(org.orgId)).toBe('active');

    const off = await setOrg(org.orgId, 'inactive');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      organization: expect.objectContaining({ id: org.orgId, status: 'inactive' }),
      changed: true,
    });
    expect(await orgStatus(org.orgId)).toBe('inactive');
    for (const r of [await orgPage(org.orgId, org.owner.cookie), await list(token)]) {
      expect([r.status, r.body.error?.code]).toEqual([403, 'organization_suspended']);
    }

    const on = await setOrg(org.orgId, 'active');
    expect([on.status, on.body.changed, on.body.organization.status]).toEqual([
      200,
      true,
      'active',
    ]);
    expect(await orgStatus(org.orgId)).toBe('active');
    expect([
      (await orgPage(org.orgId, org.owner.cookie)).status,
      (await list(token)).status,
    ]).toEqual([200, 200]);
    expect(await rows()).toEqual(before);
  });

  it('org status change writes audit_event with via provisioning_api and a provisioning audit row with the fingerprint', async () => {
    const orgId = await provisionedOrg();
    expect((await setOrg(orgId, 'inactive', 'non_payment')).status).toBe(200);
    expect(await orgAudits(orgId)).toEqual([
      {
        actor_type: 'system',
        actor_user_id: null,
        action: 'organization.suspended',
        details: {
          from: 'active',
          to: 'suspended',
          reason: 'non_payment',
          via: 'provisioning_api',
        },
        sequence: expect.anything(),
      },
    ]);
    expect(await lastProvisioningAudit()).toEqual({
      credential_fingerprint: cred.digestHex.slice(0, 12),
      action: 'organization.set_status',
      outcome: 'changed',
      target_type: 'organization',
      target_id: orgId,
      details: { from: 'active', to: 'inactive', reason: 'non_payment' },
    });
    await setOrg(orgId, 'active');
    expect((await orgAudits(orgId)).map((a) => [a.action, a.details.reason])).toEqual([
      ['organization.suspended', 'non_payment'],
      ['organization.reactivated', 'other'],
    ]);
  });

  it('repeating the same org status is 200 changed:false with no new audit_event', async () => {
    const orgId = await provisionedOrg();
    await setOrg(orgId, 'inactive');
    const again = await setOrg(orgId, 'inactive');
    expect([again.status, again.body.changed, again.body.organization.status]).toEqual([
      200,
      false,
      'inactive',
    ]);
    expect(await orgAudits(orgId)).toHaveLength(1);
    expect(await lastProvisioningAudit()).toMatchObject({
      action: 'organization.set_status',
      outcome: 'unchanged',
      target_id: orgId,
      details: {},
    });
  });

  it('deactivating a user ends open sessions and blocks sign-in and their keys', async () => {
    const u = await verifiedUser(api, 'pst-user');
    await api.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
      [org.orgId, u.userId],
    );
    const token = await newKey(org.orgId, u);
    expect((await orgPage(org.orgId, u.cookie)).status).toBe(200);

    const off = await setUser(u.userId, 'inactive');
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      user: expect.objectContaining({
        id: u.userId,
        status: 'inactive',
        memberships: [{ organizationId: org.orgId, role: 'member', organizationStatus: 'active' }],
      }),
      changed: true,
    });
    expect((await orgPage(org.orgId, u.cookie)).status).toBe(401);
    expect(
      await count('SELECT count(*) AS n FROM auth_session WHERE user_id = $1', [u.userId]),
    ).toBe(0);
    const denied = await signIn(u.email);
    expect([denied.status, denied.body.error?.code]).toEqual([401, 'invalid_credentials']);
    const key = await list(token);
    expect([key.status, key.body.error?.code]).toEqual([403, 'key_owner_inactive']);
    expect(await lastProvisioningAudit()).toMatchObject({
      action: 'user.set_status',
      outcome: 'changed',
      target_type: 'user',
      target_id: u.userId,
      details: { from: 'active', to: 'inactive', reason: 'other', soleOwnerOfCount: 0 },
    });

    const on = await setUser(u.userId, 'active');
    expect([on.status, on.body.changed, on.body.user.status]).toEqual([200, true, 'active']);
    const cookie = await login(api, u.email);
    expect((await orgPage(org.orgId, cookie)).status).toBe(200);
    expect((await list(token)).status).toBe(200);

    const again = await setUser(u.userId, 'active');
    expect([again.status, again.body.changed]).toEqual([200, false]);
    expect(await lastProvisioningAudit()).toMatchObject({ outcome: 'unchanged', details: {} });
  });

  it('user active but org inactive is still blocked on that org', async () => {
    expect((await setOrg(org.orgId, 'inactive')).status).toBe(200);
    try {
      const cookie = await login(api, org.member.email);
      const r = await orgPage(org.orgId, cookie);
      expect([r.status, r.body.error?.code]).toEqual([403, 'organization_suspended']);
    } finally {
      await setOrg(org.orgId, 'active');
    }
  });

  it('user inactive in an active org cannot sign in', async () => {
    expect((await setUser(org.admin.userId, 'inactive')).status).toBe(200);
    try {
      const r = await signIn(org.admin.email);
      expect([r.status, r.body.error?.code]).toEqual([401, 'invalid_credentials']);
    } finally {
      await setUser(org.admin.userId, 'active');
    }
  });

  it('multi-org user stays usable in the active org when the other org is deactivated', async () => {
    const other = await orgWithRoles(api, 'pst2', org);
    const token = await newKey(org.orgId, org.owner);
    expect((await setOrg(other.orgId, 'inactive')).status).toBe(200);
    try {
      const blocked = await orgPage(other.orgId, org.owner.cookie);
      expect([blocked.status, blocked.body.error?.code]).toEqual([403, 'organization_suspended']);
      expect((await orgPage(org.orgId, org.owner.cookie)).status).toBe(200);
      expect((await list(token)).status).toBe(200);
    } finally {
      await setOrg(other.orgId, 'active');
    }
  });

  it("deactivating an org's only owner is allowed and audited with soleOwnerOfCount 1", async () => {
    const orgId = await provisionedOrg();
    const created = await provisionUser(orgId);
    expect(created.status).toBe(201);
    const r = await setUser(created.body.user.id as string, 'inactive');
    expect([r.status, r.body.user.status]).toEqual([200, 'inactive']);
    expect(await lastProvisioningAudit()).toMatchObject({
      action: 'user.set_status',
      outcome: 'changed',
      details: { from: 'active', to: 'inactive', reason: 'other', soleOwnerOfCount: 1 },
    });
  });

  it('unknown org or user id is 404 not_found and audited not_found', async () => {
    for (const [kind, action, set] of [
      ['organization', 'organization.set_status', setOrg],
      ['user', 'user.set_status', setUser],
    ] as const) {
      const id = randomUUID();
      const r = await set(id, 'inactive');
      expect([r.status, r.body.error?.code]).toEqual([404, 'not_found']);
      expect(await lastProvisioningAudit()).toMatchObject({
        action,
        outcome: 'not_found',
        target_type: kind,
        target_id: id,
        details: { errorCode: 'not_found' },
      });
      const bad = await set('not-a-uuid', 'inactive');
      expect([bad.status, bad.body.error?.code]).toEqual([404, 'not_found']);
      expect(await lastProvisioningAudit()).toMatchObject({ action, target_id: null });
    }
  });

  it("status 'paused' is 400 with issue {path:'status',message:'invalid'}", async () => {
    for (const [action, url] of [
      ['organization.set_status', `organizations/${org.orgId}/status`],
      ['user.set_status', `users/${org.member.userId}/status`],
    ] as const) {
      const r = await prov('PUT', url, { status: 'paused' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({
        code: 'invalid_request',
        issues: [{ path: 'status', message: 'invalid' }],
      });
      expect(JSON.stringify(r.body)).not.toContain('paused');
      expect(await lastProvisioningAudit()).toMatchObject({
        action,
        outcome: 'invalid',
        details: { errorCode: 'invalid_request', fields: 'status' },
      });
      const extra = await prov('PUT', url, { status: 'active', reason: 'whim', note: 'x' });
      expect(extra.body.error.issues).toEqual([
        { path: 'note', message: 'unknown_field' },
        { path: 'reason', message: 'invalid' },
      ]);
    }
    expect(await orgStatus(org.orgId)).toBe('active');
  });

  it('concurrent deactivate and create-user in that org', async () => {
    for (let i = 0; i < 20; i++) {
      const orgId = await provisionedOrg();
      // A staggered start, so both orders occur: create first, or deactivate first.
      const [off, created] = await Promise.all([
        sleep(i % 5).then(() => setOrg(orgId, 'inactive')),
        provisionUser(orgId),
      ]);
      expect(off.status).toBe(200);
      expect(await orgStatus(orgId)).toBe('inactive');
      const events = (
        await api.pool.query<{ action: string; sequence: string }>(
          `SELECT action, sequence FROM audit_event
            WHERE organization_id = $1 AND action IN ('membership.provisioned', 'organization.suspended')
            ORDER BY sequence`,
          [orgId],
        )
      ).rows.map((e) => e.action);
      const members = await count(
        'SELECT count(*) AS n FROM membership WHERE organization_id = $1',
        [orgId],
      );
      if (created.status === 201) {
        expect(members).toBe(1);
        expect(events).toEqual(['membership.provisioned', 'organization.suspended']);
      } else {
        expect([created.status, created.body.error?.code]).toEqual([409, 'organization_inactive']);
        expect(members).toBe(0);
        expect(events).toEqual(['organization.suspended']);
      }
    }
  });
});
