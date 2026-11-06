import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  login,
  PASSWORD,
  provisioningCredential,
  signUpAndVerify,
  startTestApi,
  type TestApi,
  type TestResponse,
} from '../testing/harness.js';

const cred = provisioningCredential();
const PROVISIONING = { provisioning: { credentialDigests: [Buffer.from(cred.digestHex, 'hex')] } };
const NEW_PASSWORD = 'a brand new provisioned passphrase 7';

/** Every provisioning response of this file, for the leak check. */
const responses: TestResponse[] = [];

const ref = (label: string) => `${label}-${randomUUID()}`;
const mailbox = () => `${randomUUID().slice(0, 8)}@example.com`;

async function post(
  api: TestApi,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const r = await api.req('POST', url, {
    body,
    headers: { origin: '', authorization: `Bearer ${cred.token}`, ...headers },
  });
  responses.push(r);
  return r;
}

const createOrg = (api: TestApi, body: unknown, headers?: Record<string, string>) =>
  post(api, '/provisioning/v1/organizations', body, headers);
const createUser = (api: TestApi, orgId: string, body: unknown) =>
  post(api, `/provisioning/v1/organizations/${orgId}/users`, body);

const userBody = (over: Record<string, unknown> = {}) => ({
  externalRef: ref('user'),
  email: mailbox(),
  name: 'Pat Doe',
  role: 'owner',
  ...over,
});

async function newOrg(api: TestApi, name = 'Acme'): Promise<string> {
  const r = await createOrg(api, { externalRef: ref('org'), name });
  expect(r.status).toBe(201);
  return r.body.organization.id as string;
}

/** The token of the most recent email to an address. */
function emailedToken(api: TestApi, email: string): string {
  return new URL(extractFirstUrl(api.mailer.lastTo(email)!.text)!).searchParams.get('token')!;
}

/** Follows the setup email: chooses a password, then signs in. Returns the cookie. */
async function setUpAndSignIn(api: TestApi, email: string): Promise<string> {
  const reset = await api.req('POST', '/api/auth/reset-password', {
    body: { token: emailedToken(api, email), newPassword: NEW_PASSWORD },
  });
  expect(reset.status).toBe(200);
  return login(api, email, NEW_PASSWORD);
}

const lastProvisioningAudit = (api: TestApi) =>
  api.pool
    .query<{
      action: string;
      outcome: string;
      target_type: string;
      target_id: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT action, outcome, target_type, target_id, details
         FROM provisioning_audit_event ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .then((r) => r.rows[0]);

const count = async (api: TestApi, sql: string, params: unknown[]) =>
  Number((await api.pool.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('provisioning creates', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi(PROVISIONING);
  });
  afterAll(() => api.close());

  it('creates an organization and returns its id', async () => {
    const externalRef = ref('org');
    const r = await createOrg(api, { externalRef, name: '  Acme Corp ' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      organization: {
        id: expect.any(String),
        externalRef,
        name: 'Acme Corp',
        status: 'active',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
      replayed: false,
    });
    const id = r.body.organization.id as string;
    const events = await api.pool.query(
      `SELECT actor_type, actor_user_id, action, subject_type, subject_id, details
         FROM audit_event WHERE organization_id = $1`,
      [id],
    );
    expect(events.rows).toEqual([
      {
        actor_type: 'system',
        actor_user_id: null,
        action: 'organization.created',
        subject_type: 'organization',
        subject_id: id,
        details: { via: 'provisioning_api' },
      },
    ]);
    expect(await lastProvisioningAudit(api)).toEqual({
      action: 'organization.create',
      outcome: 'created',
      target_type: 'organization',
      target_id: id,
      details: {},
    });
  });

  it('replaying an org ref returns the original with 200 and creates nothing', async () => {
    const body = { externalRef: ref('org'), name: 'Replay Org' };
    const first = await createOrg(api, body);
    const again = await createOrg(api, { ...body, name: ' Replay Org ' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ organization: first.body.organization, replayed: true });
    const id = first.body.organization.id as string;
    expect(
      await count(api, 'SELECT count(*) AS n FROM organization WHERE external_ref = $1', [
        body.externalRef,
      ]),
    ).toBe(1);
    expect(
      await count(api, 'SELECT count(*) AS n FROM audit_event WHERE organization_id = $1', [id]),
    ).toBe(1);
    expect(await lastProvisioningAudit(api)).toMatchObject({
      action: 'organization.create',
      outcome: 'replayed',
      target_id: id,
    });
  });

  it('same org ref with a different name is 409 external_ref_mismatch', async () => {
    const externalRef = ref('org');
    await createOrg(api, { externalRef, name: 'Original' });
    const r = await createOrg(api, { externalRef, name: 'Renamed' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: {
        code: 'external_ref_mismatch',
        message: 'This external reference was already used with different values.',
      },
    });
    expect(await lastProvisioningAudit(api)).toEqual({
      action: 'organization.create',
      outcome: 'conflict',
      target_type: 'organization',
      target_id: null,
      details: { errorCode: 'external_ref_mismatch' },
    });
  });

  it('concurrent org creates with one ref yield one org', async () => {
    const body = { externalRef: ref('org'), name: 'Race Org' };
    const rs = await Promise.all(Array.from({ length: 10 }, () => createOrg(api, body)));
    expect(rs.map((r) => r.status).sort()).toEqual([...Array(9).fill(200), 201]);
    expect(new Set(rs.map((r) => r.body.organization.id)).size).toBe(1);
    expect(rs.filter((r) => r.body.replayed === true)).toHaveLength(9);
    expect(
      await count(api, 'SELECT count(*) AS n FROM organization WHERE external_ref = $1', [
        body.externalRef,
      ]),
    ).toBe(1);
  });

  it('creates a user who can set a password and sign in', async () => {
    const orgId = await newOrg(api);
    const body = userBody();
    const r = await createUser(api, orgId, body);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      user: {
        id: expect.any(String),
        externalRef: body.externalRef,
        email: body.email,
        name: 'Pat Doe',
        status: 'active',
        memberships: [{ organizationId: orgId, role: 'owner', organizationStatus: 'active' }],
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
      replayed: false,
      setupEmail: 'sent',
    });
    const userId = r.body.user.id as string;
    expect(api.mailer.sent.filter((m) => m.to === body.email).map((m) => m.subject)).toEqual([
      'Set up your FeedBouncer account',
    ]);
    expect(
      await count(api, 'SELECT count(*) AS n FROM auth_account WHERE user_id = $1', [userId]),
    ).toBe(0);
    const { rows } = await api.pool.query(
      'SELECT email_verified, status FROM app_user WHERE id = $1',
      [userId],
    );
    expect(rows).toEqual([{ email_verified: true, status: 'active' }]);

    const events = await api.pool.query(
      `SELECT e.actor_type, e.actor_user_id, e.action, e.subject_type, e.details, m.user_id
         FROM audit_event e JOIN membership m ON m.id = e.subject_id
        WHERE e.organization_id = $1 AND e.action = 'membership.provisioned'`,
      [orgId],
    );
    expect(events.rows).toEqual([
      {
        actor_type: 'system',
        actor_user_id: null,
        action: 'membership.provisioned',
        subject_type: 'membership',
        details: { role: 'owner', via: 'provisioning_api' },
        user_id: userId,
      },
    ]);
    expect(await lastProvisioningAudit(api)).toEqual({
      action: 'user.create',
      outcome: 'created',
      target_type: 'user',
      target_id: userId,
      details: { organizationId: orgId, role: 'owner' },
    });

    const cookie = await setUpAndSignIn(api, body.email);
    const org = await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie });
    expect(org.status).toBe(200);
  });

  it('sendSetupEmail false sends nothing', async () => {
    const orgId = await newOrg(api);
    const body = userBody({ sendSetupEmail: false, role: 'member' });
    const r = await createUser(api, orgId, body);
    expect([r.status, r.body.setupEmail]).toEqual([201, 'skipped']);
    expect(api.mailer.lastTo(body.email)).toBeUndefined();
  });

  it('setup email failure still creates the user', async () => {
    const orgId = await newOrg(api);
    const body = userBody();
    const send = api.mailer.send;
    api.mailer.send = () => Promise.reject(new Error('smtp down'));
    let r: TestResponse;
    try {
      r = await createUser(api, orgId, body);
    } finally {
      api.mailer.send = send;
    }
    expect([r.status, r.body.setupEmail]).toEqual([201, 'failed']);
    const userId = r.body.user.id as string;
    expect(await count(api, 'SELECT count(*) AS n FROM app_user WHERE id = $1', [userId])).toBe(1);
    const failures = api.logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'provisioning.setup_email_failed');
    expect(failures).toContainEqual(expect.objectContaining({ level: 'warn', userId }));
  });

  it('concurrent user creates with one ref yield one user and no email_in_use', async () => {
    const orgId = await newOrg(api);
    const body = userBody();
    const rs = await Promise.all(Array.from({ length: 10 }, () => createUser(api, orgId, body)));
    expect(rs.map((r) => r.status).sort()).toEqual([...Array(9).fill(200), 201]);
    expect(new Set(rs.map((r) => r.body.user.id)).size).toBe(1);
    expect(
      rs.filter((r) => r.body.replayed === true && r.body.setupEmail === 'skipped'),
    ).toHaveLength(9);
    expect(
      await count(api, 'SELECT count(*) AS n FROM app_user WHERE email = $1', [body.email]),
    ).toBe(1);
    expect(
      await count(api, 'SELECT count(*) AS n FROM membership WHERE organization_id = $1', [orgId]),
    ).toBe(1);
    expect(api.mailer.sent.filter((m) => m.to === body.email)).toHaveLength(1);
  });

  it('email comparison is normalized for conflicts and replays', async () => {
    const orgId = await newOrg(api);
    const a = userBody({ email: 'alice@example.com' });
    expect((await createUser(api, orgId, a)).status).toBe(201);

    const b = await createUser(api, orgId, userBody({ email: ' Alice@Example.COM ' }));
    expect([b.status, b.body.error?.code]).toEqual([409, 'email_in_use']);
    expect(b.body.error.message).toBe('This email address is already in use.');

    const replay = await createUser(api, orgId, { ...a, email: 'ALICE@example.com' });
    expect([replay.status, replay.body.replayed, replay.body.user.email]).toEqual([
      200,
      true,
      'alice@example.com',
    ]);

    const bob = await signUpAndVerify(api, 'bob@example.com');
    const before = await api.pool.query('SELECT * FROM app_user WHERE id = $1', [bob.userId]);
    const c = await createUser(api, orgId, userBody({ email: 'bob@example.com' }));
    expect([c.status, c.body.error?.code]).toEqual([409, 'email_in_use']);
    expect(
      (await api.pool.query('SELECT * FROM app_user WHERE id = $1', [bob.userId])).rows,
    ).toEqual(before.rows);
    expect(
      await count(api, 'SELECT count(*) AS n FROM membership WHERE user_id = $1', [bob.userId]),
    ).toBe(0);
  });

  it('same user ref with a different email, name, organization or role is 409 external_ref_mismatch', async () => {
    const orgId = await newOrg(api);
    const otherOrg = await newOrg(api);
    const body = userBody({ role: 'admin' });
    expect((await createUser(api, orgId, body)).status).toBe(201);
    for (const [org, over] of [
      [orgId, { email: mailbox() }],
      [orgId, { name: 'Someone Else' }],
      [orgId, { role: 'member' }],
      [otherOrg, {}],
    ] as const) {
      const r = await createUser(api, org, { ...body, ...over });
      expect([over, r.status, r.body.error?.code]).toEqual([over, 409, 'external_ref_mismatch']);
    }
    const flags = await createUser(api, orgId, {
      ...body,
      sendSetupEmail: false,
      allowInactiveOrganization: true,
    });
    expect([flags.status, flags.body.replayed]).toEqual([200, true]);
  });

  it('user in a nonexistent org is 404 not_found', async () => {
    for (const orgId of [randomUUID(), 'not-a-uuid']) {
      const r = await createUser(api, orgId, userBody());
      expect([r.status, r.body.error?.code]).toEqual([404, 'not_found']);
    }
    expect(await lastProvisioningAudit(api)).toEqual({
      action: 'user.create',
      outcome: 'not_found',
      target_type: 'user',
      target_id: null,
      details: { errorCode: 'not_found' },
    });
  });

  it('user in an inactive org is 409 organization_inactive by default and allowed with allowInactiveOrganization', async () => {
    const orgId = await newOrg(api);
    await api.pool.query("UPDATE organization SET status = 'suspended' WHERE id = $1", [orgId]);
    const body = userBody();
    const refused = await createUser(api, orgId, body);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: { code: 'organization_inactive', message: 'This organization is inactive.' },
    });
    expect(
      await count(api, 'SELECT count(*) AS n FROM app_user WHERE email = $1', [body.email]),
    ).toBe(0);

    const allowed = await createUser(api, orgId, { ...body, allowInactiveOrganization: true });
    expect(allowed.status).toBe(201);
    expect(allowed.body.user.memberships).toEqual([
      { organizationId: orgId, role: 'owner', organizationStatus: 'inactive' },
    ]);
    const cookie = await setUpAndSignIn(api, body.email);
    const org = await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie });
    expect([org.status, org.body.error?.code]).toEqual([403, 'organization_suspended']);
  });

  it('invalid input yields field issues without echoing values', async () => {
    const orgId = await newOrg(api);
    const r = await createUser(api, orgId, {
      externalRef: '../../etc',
      email: 'x',
      name: '',
      role: 'god',
      extra: '<b>',
    });
    expect([r.status, r.body.error?.code]).toEqual([400, 'invalid_request']);
    expect(r.body.error.issues.map((i: { path: string }) => i.path)).toEqual([
      'email',
      'externalRef',
      'extra',
      'name',
      'role',
    ]);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain('../../etc');
    expect(json).not.toContain('<b>');
    expect(await lastProvisioningAudit(api)).toEqual({
      action: 'user.create',
      outcome: 'invalid',
      target_type: 'user',
      target_id: null,
      details: { errorCode: 'invalid_request', fields: 'email,externalRef,extra,name,role' },
    });

    const html = '<img src=x onerror=alert(1)>' + 'a'.repeat(300);
    const org = await createOrg(api, { externalRef: `${html}`, name: html });
    expect(org.status).toBe(400);
    expect(org.body.error.issues).toEqual([
      { path: 'externalRef', message: 'too_long' },
      { path: 'name', message: 'too_long' },
    ]);
    expect(JSON.stringify(org.body)).not.toContain('<img');
    expect(await lastProvisioningAudit(api)).toMatchObject({
      action: 'organization.create',
      outcome: 'invalid',
      details: { errorCode: 'invalid_request', fields: 'externalRef,name' },
    });
  });

  it('origin check does not apply to provisioning POSTs', async () => {
    const r = await createOrg(
      api,
      { externalRef: ref('org'), name: 'Foreign Origin' },
      { origin: 'https://evil.example' },
    );
    expect(r.status).toBe(201);
  });

  it('reset emails use the setup template until the user has a password', async () => {
    const orgId = await newOrg(api);
    const body = userBody({ sendSetupEmail: false });
    expect((await createUser(api, orgId, body)).status).toBe(201);
    const requestReset = async () => {
      const r = await api.req('POST', '/api/auth/request-password-reset', {
        body: { email: body.email },
      });
      expect(r.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20)); // public resets are fire-and-forget
      return api.mailer.lastTo(body.email)!.subject;
    };
    expect(await requestReset()).toBe('Set up your FeedBouncer account');
    await setUpAndSignIn(api, body.email);
    expect(await requestReset()).toBe('Reset your FeedBouncer password');
  });

  it('no response, log line or audit row contains the credential or the setup token', async () => {
    const orgId = await newOrg(api);
    await createUser(api, orgId, userBody());
    const tokens = api.mailer.sent
      .filter((m) => m.subject === 'Set up your FeedBouncer account')
      .map((m) => extractFirstUrl(m.text))
      .map((u) => (u ? new URL(u).searchParams.get('token') : null))
      .filter((t): t is string => !!t);
    expect(tokens.length).toBeGreaterThan(3);
    const audits = await api.pool.query(
      `SELECT row_to_json(p)::text AS j FROM provisioning_audit_event p
       UNION ALL SELECT row_to_json(e)::text FROM audit_event e`,
    );
    const haystacks = [
      ...responses.map((r) => JSON.stringify([r.body, r.headers])),
      ...api.logLines,
      ...audits.rows.map((r: { j: string }) => r.j),
    ];
    for (const secret of [cred.token, ...tokens]) {
      expect(haystacks.filter((h) => h.includes(secret))).toEqual([]);
    }
  });
});

describe('provisioning creates with sign-up disabled', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi({ ...PROVISIONING, signupEnabled: false });
  });
  afterAll(() => api.close());

  it('provisioned creates work while SIGNUP_ENABLED is false', async () => {
    const orgId = await newOrg(api);
    const r = await createUser(api, orgId, userBody());
    expect([r.status, r.body.setupEmail]).toEqual([201, 'sent']);
    const signUp = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: mailbox(), password: PASSWORD, name: 'Pat' },
    });
    expect([signUp.status, signUp.body.error?.code]).toEqual([403, 'signup_disabled']);
  });
});
