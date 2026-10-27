// Threads through the API: the connect flow (permissions, consent, callback, picker),
// and the rule-save length check against the connector's reply limit. FakeThreads
// stands in for Threads.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeThreads } from '@feedbouncer/connector-threads/testing';
import { Secret } from '@feedbouncer/service-runtime';
import {
  WEB,
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
} from './testing/harness.js';

const THREADS = {
  appId: '2220001112223334',
  appSecret: new Secret('threads-app-secret-0123456789'),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FOUR_SCOPES = [
  'threads_basic',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_content_publish',
];

let api: TestApi;
let fake: FakeThreads;
let f: OrgFixture;

beforeAll(async () => {
  fake = new FakeThreads({ appId: THREADS.appId, appSecret: 'threads-app-secret-0123456789' });
  api = await startTestApi({ threads: THREADS }, { fetch: fake.fetch });
  f = await orgWithRoles(api, 'thr-e2e');
});
afterAll(() => api?.close());

const base = () => `/api/v1/orgs/${f.orgId}/brands/${f.brandId}`;
const call = (method: string, path: string, body?: unknown) =>
  api.req(method, `${base()}${path}`, { cookie: f.admin.cookie, body });

async function authorizeState(): Promise<{ url: URL; state: string }> {
  const authorized = await call('POST', '/connections/threads/authorize', {});
  expect(authorized.status).toBe(200);
  const url = new URL(authorized.body.authorizationUrl);
  return { url, state: url.searchParams.get('state')! };
}

const connectionsOf = async () =>
  (
    await api.pool.query<{ external_account_id: string; granted_scopes: string[] }>(
      `SELECT external_account_id, granted_scopes FROM connection
        WHERE organization_id = $1 AND platform = 'threads' AND status = 'active'`,
      [f.orgId],
    )
  ).rows;

const grantCount = async () =>
  (await api.pool.query('SELECT 1 FROM oauth_grant WHERE organization_id = $1', [f.orgId]))
    .rowCount;

describe('threads connect flow', () => {
  it('lists the four permissions with purposes before connecting, two required', async () => {
    const r = await call('GET', '/connections/threads/permissions');
    expect(r.status).toBe(200);
    expect(r.body.permissions).toEqual([
      expect.objectContaining({ scope: 'threads_basic', required: true }),
      expect.objectContaining({ scope: 'threads_read_replies', required: true }),
      expect.objectContaining({ scope: 'threads_manage_replies', required: false }),
      expect.objectContaining({ scope: 'threads_content_publish', required: false }),
    ]);
    for (const p of r.body.permissions) expect(p.purpose).toEqual(expect.any(String));
  });

  it('connect flow: authorize URL on threads.com with four scopes → callback → picker shows one account → connected with granted_scopes', async () => {
    const { userId, authCode } = fake.addUser({ username: 'shop.owner' });
    const { url, state } = await authorizeState();
    expect(url.hostname).toBe('threads.com');
    expect(url.searchParams.get('scope')!.split(/[ ,]/).sort()).toEqual([...FOUR_SCOPES].sort());

    const cb = await api.req(
      'GET',
      `/api/v1/oauth/threads/callback?code=${authCode}&state=${state}`,
      {
        cookie: f.admin.cookie,
      },
    );
    expect(cb.status).toBe(302);
    const grant = new RegExp(
      `^${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections/threads/select\\?grant=(${UUID_RE})$`,
    ).exec(String(cb.headers.location))![1]!;

    const picker = await call('GET', `/connections/threads/grants/${grant}`);
    expect(picker.status).toBe(200);
    expect(picker.body.accounts).toHaveLength(1);
    expect(picker.body.accounts[0]).toMatchObject({ externalAccountId: userId });

    const connected = await call('POST', `/connections/threads/grants/${grant}/connect`, {
      accountIds: [userId],
    });
    expect(connected.status).toBe(200);
    expect(connected.body.results).toEqual([
      expect.objectContaining({ externalAccountId: userId, status: 'connected' }),
    ]);
    const [row] = await connectionsOf();
    expect(row!.external_account_id).toBe(userId);
    expect([...row!.granted_scopes].sort()).toEqual([...FOUR_SCOPES].sort());
  });

  it('callback with error=access_denied → denied, nothing stored', async () => {
    const before = await connectionsOf();
    const grantsBefore = await grantCount();
    const { state } = await authorizeState();
    const cb = await api.req(
      'GET',
      `/api/v1/oauth/threads/callback?error=access_denied&state=${state}`,
      { cookie: f.admin.cookie },
    );
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toBe(
      `${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections?error=denied`,
    );
    expect(await connectionsOf()).toEqual(before);
    expect(await grantCount()).toBe(grantsBefore);
  });

  it('grant missing threads_read_replies → missing_permissions, nothing stored', async () => {
    const before = await connectionsOf();
    const { authCode } = fake.addUser({ scopes: ['threads_basic', 'threads_manage_replies'] });
    const { state } = await authorizeState();
    const cb = await api.req(
      'GET',
      `/api/v1/oauth/threads/callback?code=${authCode}&state=${state}`,
      {
        cookie: f.admin.cookie,
      },
    );
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toBe(
      `${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections?error=missing_permissions&missing=threads_read_replies`,
    );
    expect(await connectionsOf()).toEqual(before);
  });
});

describe('threads reply templates at rule save', () => {
  const rule = (template: string) => ({
    name: `threads reply ${template.length}`,
    conditions: { type: 'keyword', terms: ['zq-threads'] },
    actions: [{ type: 'auto_reply', template }],
  });

  it('rule save with an auto_reply template whose worst case exceeds 500 chars on a brand with Threads → 422 template_too_long naming threads and 500', async () => {
    expect((await connectionsOf()).length).toBeGreaterThan(0);
    const r = await call('POST', '/rules', rule('x'.repeat(501)));
    expect(r.status).toBe(422);
    expect(r.body.error.issues[0]).toMatchObject({
      path: 'actions.0',
      message: 'template_too_long',
      platform: 'threads',
      max: 500,
    });
  });

  it('a template of exactly 500 chars is saved', async () => {
    const r = await call('POST', '/rules', rule('x'.repeat(500)));
    expect(r.status).toBe(201);
  });

  it('a 2001-char template → 422 too_long', async () => {
    const r = await call('POST', '/rules', rule('x'.repeat(2001)));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error)).toContain('too_long');
  });
});
