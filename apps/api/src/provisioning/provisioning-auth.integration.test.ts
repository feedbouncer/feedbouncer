import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgApiKeys } from '@feedbouncer/public-api';
import { CASES } from '../security/isolation-cases.js';
import { nestHandlers } from '../security/nest-handlers.js';
import { PROVISIONING_ROUTES } from '../security/provisioning-cases.js';
import {
  provisioningCredential,
  startTestApi,
  verifiedUser,
  type TestApi,
} from '../testing/harness.js';

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const PUBLIC_SPEC = 'GET /v1/openapi.json';
const UNAUTHENTICATED = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const REALM = 'Bearer realm="FeedBouncer Provisioning"';

const cred = provisioningCredential();
const next = provisioningCredential();
const withDigests = (...digests: string[]) => ({
  provisioning: { credentialDigests: digests.map((d) => Buffer.from(d, 'hex')) },
  trustProxyHops: 1,
});

let ipCounter = 0;
/** A fresh client address per test, so failure budgets do not leak between tests. */
const freshIp = () => `203.0.113.${++ipCounter}`;

const send = (
  api: TestApi,
  method: string,
  url: string,
  opts: { token?: string; ip?: string; headers?: Record<string, string>; cookie?: string } = {},
) =>
  api.req(method, url, {
    ...(opts.cookie && { cookie: opts.cookie }),
    headers: {
      origin: '',
      ...(opts.token !== undefined && { authorization: `Bearer ${opts.token}` }),
      ...(opts.ip && { 'x-forwarded-for': opts.ip }),
      ...opts.headers,
    },
  });

const auditRows = (api: TestApi) =>
  api.pool
    .query<{
      action: string;
      outcome: string;
      target_type: string;
      target_id: string | null;
      credential_fingerprint: string;
      details: Record<string, unknown>;
    }>('SELECT * FROM provisioning_audit_event ORDER BY created_at, id')
    .then((r) => r.rows);

async function tenant(api: TestApi, label: string): Promise<Tenant> {
  const c = await api.pool.connect();
  try {
    return await seedTenant(c, label);
  } finally {
    c.release();
  }
}

describe('provisioning API disabled', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi();
  });
  afterAll(() => api.close());

  it('disabled deployment answers 404 identical to an unknown route', async () => {
    const unknown = await api.req('GET', '/no-such-route');
    expect(unknown.status).toBe(404);
    for (const route of PROVISIONING_ROUTES) {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:\w+/g, ZERO_UUID);
      for (const headers of [{}, { authorization: `Bearer ${cred.token}` }]) {
        const r = await api.req(method, url, { headers, body: method === 'GET' ? undefined : {} });
        expect([route, r.status, r.body]).toEqual([route, unknown.status, unknown.body]);
      }
    }
    expect(await api.deps.redis.keys(`${api.deps.redisKeyPrefix}rl:prov-auth*`)).toEqual([]);
  });

  it('disabled deployment answers 404 even to a token hashing to the empty-string digest', async () => {
    const unknown = await api.req('GET', '/no-such-route');
    for (const authorization of ['Bearer ', 'Bearer', `Bearer ${cred.token}`]) {
      const r = await api.req('GET', `/provisioning/v1/organizations/${ZERO_UUID}`, {
        headers: { authorization, origin: '' },
      });
      expect([r.status, r.body]).toEqual([unknown.status, unknown.body]);
    }
    expect(await api.deps.redis.keys(`${api.deps.redisKeyPrefix}rl:prov-auth*`)).toEqual([]);
  });
});

describe('provisioning API authentication', () => {
  let api: TestApi;
  let t: Tenant;
  beforeAll(async () => {
    api = await startTestApi(withDigests(cred.digestHex, next.digestHex));
    t = await tenant(api, 'prov');
  });
  afterAll(() => api.close());

  it('valid credential reads an organization', async () => {
    const before = (await auditRows(api)).length;
    const r = await send(api, 'GET', `/provisioning/v1/organizations/${t.organizationId}`, {
      token: cred.token,
      ip: freshIp(),
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      organization: {
        id: t.organizationId,
        externalRef: null,
        name: 'Org prov',
        status: 'active',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    });
    const rows = (await auditRows(api)).slice(before);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'organization.read',
        outcome: 'read',
        target_type: 'organization',
        target_id: t.organizationId,
        credential_fingerprint: cred.digestHex.slice(0, 12),
        details: {},
      }),
    ]);
  });

  it('valid credential reads a user with memberships', async () => {
    await api.pool.query("UPDATE organization SET status = 'suspended' WHERE id = $1", [
      t.organizationId,
    ]);
    try {
      const r = await send(api, 'GET', `/provisioning/v1/users/${t.userId}`, {
        token: cred.token,
        ip: freshIp(),
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        user: {
          id: t.userId,
          externalRef: null,
          email: expect.stringMatching(/^prov-.+@example\.test$/),
          name: null,
          status: 'active',
          memberships: [
            { organizationId: t.organizationId, role: 'owner', organizationStatus: 'inactive' },
          ],
          createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        },
      });
      expect((await auditRows(api)).at(-1)).toMatchObject({
        action: 'user.read',
        outcome: 'read',
        target_type: 'user',
        target_id: t.userId,
      });
    } finally {
      await api.pool.query("UPDATE organization SET status = 'active' WHERE id = $1", [
        t.organizationId,
      ]);
    }
  });

  it('each of: no header, an empty bearer, a wrong fbp token, an fbk API key, a session cookie → 401 with www-authenticate', async () => {
    const owner = await verifiedUser(api, 'prov-owner');
    const created = await api.req('POST', '/api/v1/orgs', {
      cookie: owner.cookie,
      body: { name: 'Owned Org' },
    });
    expect(created.status).toBe(201);
    const ownedOrgId = created.body.organization.id as string;
    const { token: apiKey } = await new PgApiKeys(api.pool).create(ownedOrgId, owner.userId, {
      name: 'prov-probe',
      scope: 'write',
    });
    const before = (await auditRows(api)).length;
    const attempts: { label: string; token?: string; cookie?: string }[] = [
      { label: 'no header' },
      { label: 'empty bearer', token: '' },
      { label: 'wrong fbp token', token: provisioningCredential().token },
      { label: 'fbk API key of an owner', token: apiKey.reveal() },
      { label: 'session cookie of a verified owner', cookie: owner.cookie },
    ];
    for (const id of [ownedOrgId, randomUUID()]) {
      for (const a of attempts) {
        const r = await send(api, 'GET', `/provisioning/v1/organizations/${id}`, {
          ...a,
          ip: freshIp(),
        });
        expect([a.label, r.status, r.body, r.headers['www-authenticate']]).toEqual([
          a.label,
          401,
          UNAUTHENTICATED,
          REALM,
        ]);
      }
    }
    expect((await auditRows(api)).length).toBe(before);
  });

  it('rotation: both configured digests are accepted, and the fingerprint tells them apart', async () => {
    const url = `/provisioning/v1/organizations/${t.organizationId}`;
    for (const c of [cred, next]) {
      const r = await send(api, 'GET', url, { token: c.token, ip: freshIp() });
      expect(r.status).toBe(200);
      expect((await auditRows(api)).at(-1)?.credential_fingerprint).toBe(c.digestHex.slice(0, 12));
    }
    expect(cred.digestHex.slice(0, 12)).not.toBe(next.digestHex.slice(0, 12));

    const rotated = await startTestApi(withDigests(next.digestHex));
    try {
      const u = await tenant(rotated, 'rot');
      const path = `/provisioning/v1/organizations/${u.organizationId}`;
      expect((await send(rotated, 'GET', path, { token: cred.token })).status).toBe(401);
      expect((await send(rotated, 'GET', path, { token: next.token })).status).toBe(200);
    } finally {
      await rotated.close();
    }
  });

  it('service credential is rejected on every user-facing route', async () => {
    const covered = new Set(CASES.map((c) => c.route));
    const routes = nestHandlers(api.app)
      .map((h) => h.route)
      .filter((r) => {
        const path = r.split(' ')[1]!;
        return covered.has(r) || (path.startsWith('/v1/') && r !== PUBLIC_SPEC);
      });
    expect(routes.length).toBeGreaterThan(covered.size);
    for (const route of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const r = await api.req(method, path.replace(/:\w+/g, ZERO_UUID), {
        body: method === 'GET' ? undefined : {},
        headers: { authorization: `Bearer ${cred.token}`, 'x-forwarded-for': freshIp() },
      });
      expect([route, r.status, r.body?.error?.code]).toEqual([route, 401, 'unauthenticated']);
    }
  });

  it('failed auth is throttled per IP', async () => {
    const ip = freshIp();
    const url = `/provisioning/v1/organizations/${t.organizationId}`;
    for (let i = 0; i < 10; i++) {
      const r = await send(api, 'GET', url, { token: provisioningCredential().token, ip });
      expect(r.status).toBe(401);
    }
    const blocked = await send(api, 'GET', url, { token: cred.token, ip });
    expect([blocked.status, blocked.body?.error?.code]).toEqual([429, 'rate_limited']);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    const other = await send(api, 'GET', url, { token: cred.token, ip: freshIp() });
    expect(other.status).toBe(200);
  });

  it('unknown ids give 404 not_found after auth, audited as not_found, and a non-UUID id gives 404', async () => {
    for (const [kind, base] of [
      ['organization', '/provisioning/v1/organizations'],
      ['user', '/provisioning/v1/users'],
    ] as const) {
      const id = randomUUID();
      const before = (await auditRows(api)).length;
      const missing = await send(api, 'GET', `${base}/${id}`, { token: cred.token, ip: freshIp() });
      expect([missing.status, missing.body?.error?.code]).toEqual([404, 'not_found']);
      const bad = await send(api, 'GET', `${base}/not-a-uuid`, {
        token: cred.token,
        ip: freshIp(),
      });
      expect([bad.status, bad.body]).toEqual([404, missing.body]);
      const rows = (await auditRows(api)).slice(before);
      expect(rows.map((r) => [r.action, r.outcome, r.target_type, r.target_id])).toEqual([
        [`${kind}.read`, 'not_found', kind, id],
        [`${kind}.read`, 'not_found', kind, null],
      ]);
      expect(rows.map((r) => r.details)).toEqual([
        { errorCode: 'not_found' },
        { errorCode: 'not_found' },
      ]);
    }
  });

  it('a non-UUID id is not parsed before authentication', async () => {
    const r = await send(api, 'GET', '/provisioning/v1/organizations/not-a-uuid', {
      ip: freshIp(),
    });
    expect([r.status, r.body]).toEqual([401, UNAUTHENTICATED]);
  });

  it('logs never contain the token', async () => {
    const wrong = provisioningCredential().token;
    await send(api, 'GET', `/provisioning/v1/organizations/${t.organizationId}`, {
      token: wrong,
      ip: freshIp(),
    });
    for (const secret of [wrong, cred.token, next.token]) {
      expect(api.logLines.filter((l) => l.includes(secret))).toEqual([]);
    }
    const failures = api.logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'provisioning.auth_failed');
    expect(failures).toContainEqual(
      expect.objectContaining({
        reason: 'mismatch',
        route: 'GET /provisioning/v1/organizations/:organizationId',
      }),
    );
    expect(failures.map((l) => l.reason)).toEqual(
      expect.arrayContaining(['missing', 'malformed', 'mismatch']),
    );
  });
});
