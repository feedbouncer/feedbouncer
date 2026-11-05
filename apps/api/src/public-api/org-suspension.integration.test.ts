import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys, type ApiKeyScope } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let api: TestApi;
let keys: PgApiKeys;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  keys = new PgApiKeys(api.pool);
  users = await orgWithRoles(api, 'susp-base');
});
afterAll(() => api.close());

let seq = 0;
const freshOrg = () => orgWithRoles(api, `susp${++seq}`, users);
const newKey = async (org: OrgFixture, scope: ApiKeyScope = 'read') => {
  const { key, token } = await keys.create(org.orgId, org.owner.userId, {
    name: `k${++seq}`,
    scope,
  });
  return { key, token: token.reveal() };
};
const setStatus = (orgId: string, s: string) =>
  api.pool.query('UPDATE organization SET status = $2 WHERE id = $1', [orgId, s]);
const call = (method: string, path: string, token: string) =>
  api.req(method, path, {
    headers: { 'x-forwarded-for': `198.51.100.${++seq % 250}`, authorization: `Bearer ${token}` },
  });
const list = (token: string) => call('GET', '/v1/comments', token);

describe('public API and suspended organizations', () => {
  it('active org key works', async () => {
    const org = await freshOrg();
    expect((await list((await newKey(org)).token)).status).toBe(200);
  });

  it('suspended org key gets 403 organization_suspended with a minimal body', async () => {
    const org = await freshOrg();
    const { token } = await newKey(org);
    await setStatus(org.orgId, 'suspended');
    const r = await list(token);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: { code: 'organization_suspended', message: 'This organization is suspended.' },
    });
    expect(JSON.stringify(r.body)).not.toContain(org.orgId);
  });

  it("wrong secret for a suspended org's key is 401 unauthenticated", async () => {
    const org = await freshOrg();
    const { token } = await newKey(org);
    await setStatus(org.orgId, 'suspended');
    const r = await list(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
    expect(r.headers['www-authenticate']).toBeDefined();
  });

  it('revoked key of a suspended org is still 401, and stays 401 after reactivation', async () => {
    const org = await freshOrg();
    const { key, token } = await newKey(org);
    await keys.revoke(org.orgId, org.owner.userId, key.id);
    await setStatus(org.orgId, 'suspended');
    expect((await list(token)).status).toBe(401);
    await setStatus(org.orgId, 'active');
    expect((await list(token)).status).toBe(401);
  });

  it('reactivation restores non-revoked keys', async () => {
    const org = await freshOrg();
    const { token } = await newKey(org);
    await setStatus(org.orgId, 'suspended');
    expect((await list(token)).status).toBe(403);
    await setStatus(org.orgId, 'active');
    expect((await list(token)).status).toBe(200);
  });

  it("another org's key keeps working while one org is suspended", async () => {
    const a = await freshOrg();
    const b = await freshOrg();
    const { token } = await newKey(b);
    await setStatus(a.orgId, 'suspended');
    expect((await list(token)).status).toBe(200);
  });

  it('status is checked before scope', async () => {
    const org = await freshOrg();
    const { token } = await newKey(org, 'read');
    await setStatus(org.orgId, 'suspended');
    const r = await call('POST', `/v1/comments/${randomUUID()}/hide`, token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('organization_suspended');
  });

  it('creating a key in a suspended org is denied', async () => {
    const org = await freshOrg();
    await setStatus(org.orgId, 'suspended');
    const r = await api.req('POST', `/api/v1/orgs/${org.orgId}/api-keys`, {
      cookie: org.owner.cookie,
      body: { name: 'late', scope: 'read' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('organization_suspended');
  });

  it('denials are logged without the token', async () => {
    const org = await freshOrg();
    const { key, token } = await newKey(org);
    await setStatus(org.orgId, 'suspended');
    await list(token);
    const line = api.logLines.find(
      (l) => l.includes('org.access_denied_suspended') && l.includes(key.id),
    );
    expect(line).toBeDefined();
    expect(line).toContain('"via":"api_key"');
    expect(line).toContain(`"apiKeyId":"${key.id}"`);
    expect(api.logLines.some((l) => l.includes(token))).toBe(false);
  });

  it('does not bump last_used_at for a denied request', async () => {
    const org = await freshOrg();
    const { key, token } = await newKey(org);
    await setStatus(org.orgId, 'suspended');
    await list(token);
    const { rows } = await api.pool.query('SELECT last_used_at FROM api_key WHERE id = $1', [
      key.id,
    ]);
    expect(rows[0].last_used_at).toBeNull();
  });
});
