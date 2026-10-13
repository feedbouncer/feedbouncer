// The Facebook connect flow end to end over the API, with FakeGraph as the
// platform behind SafeHttp: authorize -> consent -> callback -> select -> connect.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { INGEST_JOB } from '@feedbouncer/comments';
import { Secret } from '@feedbouncer/service-runtime';
import {
  WEB,
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestResponse,
  type TestUser,
} from '../testing/harness.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const APP_ID = '1112223334';
const FACEBOOK = {
  appId: APP_ID,
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let api: TestApi;
let graph: FakeGraph;
let org: OrgFixture;
let other: OrgFixture;
let fbUserId: string;
/** Every response seen, for the secret-leak check at the end. */
const seen: TestResponse[] = [];

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi({ facebook: FACEBOOK }, { fetch: graph.fetch });
  org = await orgWithRoles(api, 'fbc');
  // Same people, another organization (each test file has a small email budget).
  other = await orgWithRoles(api, 'fbo', {
    owner: org.admin,
    admin: org.owner,
    member: org.member,
  });
  fbUserId = graph.addUser('Dana').userId;
});
afterAll(() => api.close());

async function call(
  method: string,
  url: string,
  user: TestUser,
  body?: unknown,
): Promise<TestResponse> {
  const r = await api.req(method, url, { cookie: user.cookie, body });
  seen.push(r);
  return r;
}

const base = (f: OrgFixture) => `/api/v1/orgs/${f.orgId}/brands/${f.brandId}/connections`;

async function authorize(f: OrgFixture, user: TestUser, body: unknown = {}): Promise<URL> {
  const r = await call('POST', `${base(f)}/facebook/authorize`, user, body);
  expect(r.status).toBe(200);
  const url = new URL(r.body.authorizationUrl);
  expect(url.hostname).toBe('www.facebook.com');
  return url;
}

const callback = (user: TestUser, c: { code: string; state: string }) =>
  call(
    'GET',
    `/api/v1/oauth/facebook/callback?code=${encodeURIComponent(c.code)}&state=${c.state}`,
    user,
  );

/** authorize -> consent -> callback; returns the grant id from the redirect. */
async function grantFor(f: OrgFixture, body: unknown = {}): Promise<string> {
  const url = await authorize(f, f.owner, body);
  const r = await callback(f.owner, graph.consent(url, fbUserId));
  expect(r.status).toBe(302);
  const location = String(r.headers.location);
  const m = new RegExp(
    `^${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections/facebook/select\\?grant=(${UUID_RE})$`,
  ).exec(location);
  expect(m, location).not.toBeNull();
  return m![1]!;
}

async function connect(f: OrgFixture, grantId: string, pageIds: string[]) {
  const r = await call('POST', `${base(f)}/facebook/grants/${grantId}/connect`, f.owner, {
    pageIds,
  });
  expect(r.status).toBe(200);
  return r.body.results as {
    externalAccountId: string;
    status: string;
    connectionId: string | null;
  }[];
}

async function connectPage(f: OrgFixture, pageId: string, body: unknown = {}) {
  return (await connect(f, await grantFor(f, body), [pageId]))[0]!;
}

const listConnections = async (f: OrgFixture) => {
  const r = await call('GET', base(f), f.owner);
  expect(r.status).toBe(200);
  return r.body.connections as { id: string; status: string; externalAccountId: string }[];
};

const lifecycleJobs = async (connectionId: string) =>
  (
    await api.pool.query<{ payload: { op: string; nonce: string } }>(
      `SELECT payload FROM job_ledger WHERE connection_id = $1 AND job_type = 'connection_lifecycle'
        ORDER BY created_at`,
      [connectionId],
    )
  ).rows.map((r) => r.payload);

describe('facebook connect flow', () => {
  it('authorize -> callback -> select -> connect: page is Connected, token stored encrypted, setup job enqueued', async () => {
    const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop' });
    const grantId = await grantFor(org);

    const g = await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.owner);
    expect(g.status).toBe(200);
    expect(g.body.accounts).toContainEqual({
      externalAccountId: pageId,
      displayName: 'Shop',
      eligible: true,
      ineligibleReason: null,
      limitations: [],
      connection: null,
    });

    const [res] = await connect(org, grantId, [pageId]);
    expect(res).toMatchObject({ externalAccountId: pageId, status: 'connected' });
    const connectionId = res!.connectionId!;

    expect(await listConnections(org)).toContainEqual({
      id: connectionId,
      platform: 'facebook',
      displayName: 'Shop',
      externalAccountId: pageId,
      status: 'connected',
      statusReason: null,
    });
    const secret = await api.pool.query<{ encrypted_value: Buffer }>(
      `SELECT encrypted_value FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'`,
      [connectionId],
    );
    expect(secret.rows).toHaveLength(1);
    expect(secret.rows[0]!.encrypted_value.includes(Buffer.from(pageToken))).toBe(false);

    const authorized = await api.pool.query<{ sequence: string }>(
      `SELECT sequence FROM audit_event WHERE subject_id = $1 AND action = 'connection.authorized'`,
      [connectionId],
    );
    expect(await lifecycleJobs(connectionId)).toEqual([
      { op: 'setup', nonce: `${connectionId}:${authorized.rows[0]!.sequence}` },
    ]);
    // The grant is single-use.
    const again = await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.owner);
    expect(again.status).toBe(404);
  });

  it('setup that cannot be queued after connect leaves the page needing reconnect, and reconnecting subscribes it', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bakery' });
    const grantId = await grantFor(org);
    const spy = vi.spyOn(api.deps.producer!, 'enqueue').mockRejectedValueOnce(new Error('down'));
    const r = await call('POST', `${base(org)}/facebook/grants/${grantId}/connect`, org.owner, {
      pageIds: [pageId],
    });
    spy.mockRestore();
    expect(r.status).toBe(503);

    const listed = (await listConnections(org)).find((c) => c.externalAccountId === pageId);
    expect(listed).toMatchObject({ status: 'needs_reconnect' });

    const again = await connectPage(org, pageId, { reconnectConnectionId: listed!.id });
    expect(again).toMatchObject({ status: 'reconnected', connectionId: listed!.id });
    expect(await lifecycleJobs(listed!.id)).toHaveLength(1);
  });

  it('declined permission -> redirect with error=missing_permissions&missing=pages_messaging and no connection rows', async () => {
    const before = await api.pool.query('SELECT id FROM connection');
    const url = await authorize(org, org.owner);
    const r = await callback(
      org.owner,
      graph.consent(url, fbUserId, { decline: ['pages_messaging'] }),
    );
    expect(r.status).toBe(302);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=missing_permissions&missing=pages_messaging`,
    );
    expect((await api.pool.query('SELECT id FROM connection')).rows).toEqual(before.rows);
    expect((await api.pool.query('SELECT id FROM oauth_grant')).rows).toEqual([]);
  });

  it('a denied consent and a platform failure redirect with fixed error codes', async () => {
    const denied = await authorize(org, org.owner);
    const d = await call(
      'GET',
      `/api/v1/oauth/facebook/callback?error=access_denied&state=${denied.searchParams.get('state')}`,
      org.owner,
    );
    expect(d.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=denied`,
    );
    const failing = await authorize(org, org.owner);
    const consent = graph.consent(failing, fbUserId);
    graph.failNext(2);
    const p = await callback(org.owner, consent);
    expect(p.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=platform_error`,
    );
  });

  it('reconnecting an existing page refreshes the token, keeps one row, and replays needs_reconnection dead letters', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Cafe' });
    const first = await connectPage(org, pageId);
    const connectionId = first.connectionId!;
    const scope = { organizationId: org.orgId, brandId: org.brandId, connectionId };
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [connectionId],
    );
    expect(await listConnections(org)).toContainEqual(
      expect.objectContaining({
        id: connectionId,
        status: 'needs_reconnect',
        statusReason: 'oauth_access_rejected',
      }),
    );
    const oldSecret = await api.pool.query<{ encrypted_value: Buffer }>(
      `SELECT encrypted_value FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'`,
      [connectionId],
    );
    const job = await api.deps.producer!.enqueue({
      scope,
      platform: 'facebook',
      type: INGEST_JOB.type,
      payload: {
        sourceExternalId: `${pageId}_1`,
        commentExternalId: `${pageId}_1_2`,
        event: 'created',
        platformEventSec: 1_760_000_000,
        changeId: '0123456789abcdef',
      },
    });
    await api.pool.query(
      `UPDATE job_ledger SET state = 'dead_lettered', dead_letter_reason = 'needs_reconnection',
              dead_lettered_at = now(), last_error_kind = 'needs_reconnection',
              last_error_code = 'oauth_access_rejected'
        WHERE id = $1`,
      [job.ledgerId],
    );

    const again = await connectPage(org, pageId, { reconnectConnectionId: connectionId });
    expect(again).toMatchObject({ status: 'reconnected', connectionId });
    expect(await listConnections(org)).toContainEqual(
      expect.objectContaining({ id: connectionId, status: 'connected', statusReason: null }),
    );
    const rows = await api.pool.query(
      `SELECT id FROM connection WHERE platform = 'facebook' AND external_account_id = $1`,
      [pageId],
    );
    expect(rows.rows).toEqual([{ id: connectionId }]);
    const newSecret = await api.pool.query<{ encrypted_value: Buffer }>(
      `SELECT encrypted_value FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'`,
      [connectionId],
    );
    expect(newSecret.rows[0]!.encrypted_value.equals(oldSecret.rows[0]!.encrypted_value)).toBe(
      false,
    );
    const ledger = await api.pool.query(`SELECT state, replays FROM job_ledger WHERE id = $1`, [
      job.ledgerId,
    ]);
    expect(ledger.rows[0]).toEqual({ state: 'queued', replays: 1 });
    // One setup job per (re)connect.
    expect((await lifecycleJobs(connectionId)).map((p) => p.op)).toEqual(['setup', 'setup']);
  });

  it('page connected in another org -> results[0].status connected_elsewhere; no info about the other org in the response', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bakery' });
    const mine = await connectPage(org, pageId);
    const grantId = await grantFor(other);
    const g = await call('GET', `${base(other)}/facebook/grants/${grantId}`, other.owner);
    expect(g.body.accounts).toContainEqual(
      expect.objectContaining({ externalAccountId: pageId, connection: 'elsewhere' }),
    );
    const r = await call('POST', `${base(other)}/facebook/grants/${grantId}/connect`, other.owner, {
      pageIds: [pageId],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      results: [
        {
          externalAccountId: pageId,
          status: 'connected_elsewhere',
          connectionId: null,
          wasReconnectRequired: false,
        },
      ],
    });
    for (const leak of [org.orgId, org.brandId, mine.connectionId!])
      expect(JSON.stringify([g.body, r.body])).not.toContain(leak);
    expect(await listConnections(other)).toEqual([]);
  });

  it('member role cannot authorize or connect (403/404 per OrgAccessGuard conventions)', async () => {
    const grantId = await grantFor(org);
    const forbidden = { error: { code: 'forbidden', message: expect.any(String) as string } };
    const a = await call('POST', `${base(org)}/facebook/authorize`, org.member, {});
    expect(a.status).toBe(403);
    expect(a.body).toEqual(forbidden);
    const g = await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.member);
    expect(g.status).toBe(403);
    const c = await call('POST', `${base(org)}/facebook/grants/${grantId}/connect`, org.member, {
      pageIds: ['1'],
    });
    expect(c.status).toBe(403);
    // Someone else's grant (the owner's) is a 404 even for an admin, and is not consumed.
    const admin = await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.admin);
    expect(admin.status).toBe(404);
    expect((await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.owner)).status).toBe(
      200,
    );
  });

  it('validates bodies and ids', async () => {
    const bad = async (url: string, body: unknown, status: number) =>
      expect((await call('POST', url, org.owner, body)).status, JSON.stringify(body)).toBe(status);
    await bad(`${base(org)}/facebook/authorize`, { reconnectConnectionId: 'x' }, 400);
    await bad(`${base(org)}/facebook/authorize`, { extra: 1 }, 400);
    await bad(
      `${base(org)}/facebook/authorize`,
      { reconnectConnectionId: '00000000-0000-4000-8000-000000000000' },
      404,
    );
    const grant = `${base(org)}/facebook/grants/00000000-0000-4000-8000-000000000000/connect`;
    await bad(grant, { pageIds: [] }, 400);
    await bad(grant, { pageIds: ['../me'] }, 400);
    await bad(grant, { pageIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) }, 400);
    await bad(grant, { pageIds: ['1'] }, 404);
    await bad(`${base(org)}/facebook/grants/nope/connect`, { pageIds: ['1'] }, 404);
  });

  it('callback state completed by another signed-in user -> /orgs?error=oauth_rejected and state still usable by the owner', async () => {
    const url = await authorize(org, org.owner);
    const consent = graph.consent(url, fbUserId);
    const stolen = await callback(org.admin, consent);
    expect(stolen.status).toBe(302);
    expect(stolen.headers.location).toBe(`${WEB}/orgs?error=oauth_rejected`);
    const garbage = await call('GET', '/api/v1/oauth/facebook/callback?state=x&code=y', org.owner);
    expect(garbage.headers.location).toBe(`${WEB}/orgs?error=oauth_rejected`);
    const mine = await callback(org.owner, consent);
    expect(String(mine.headers.location)).toMatch(/\/connections\/facebook\/select\?grant=/);
    const anonymous = await api.req(
      'GET',
      `/api/v1/oauth/facebook/callback?code=c&state=${consent.state}`,
    );
    expect(anonymous.status).toBe(401);
  });

  it('disconnect -> 204, status disappears from list, teardown job enqueued; second DELETE also 204 and no duplicate job', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bar' });
    const { connectionId } = await connectPage(org, pageId);
    const del = await call('DELETE', `${base(org)}/${connectionId}`, org.owner);
    expect(del.status).toBe(204);
    expect((await listConnections(org)).map((c) => c.id)).not.toContain(connectionId);
    const disconnected = await api.pool.query<{ sequence: string }>(
      `SELECT sequence FROM audit_event WHERE subject_id = $1 AND action = 'connection.disconnected'`,
      [connectionId],
    );
    const teardown = { op: 'teardown', nonce: `${connectionId}:${disconnected.rows[0]!.sequence}` };
    expect((await lifecycleJobs(connectionId!)).filter((p) => p.op === 'teardown')).toEqual([
      teardown,
    ]);
    const again = await call('DELETE', `${base(org)}/${connectionId}`, org.owner);
    expect(again.status).toBe(204);
    expect((await lifecycleJobs(connectionId!)).filter((p) => p.op === 'teardown')).toEqual([
      teardown,
    ]);
    expect(
      (await call('DELETE', `${base(org)}/00000000-0000-4000-8000-000000000000`, org.owner)).status,
    ).toBe(404);
    expect((await call('DELETE', `${base(org)}/${connectionId}`, org.member)).status).toBe(403);
  });

  it('disconnecting a connection revoked for another reason removes it, audits it and queues one teardown', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Gone' });
    const { connectionId } = await connectPage(org, pageId);
    await api.pool.query(
      `UPDATE connection SET status = 'revoked', status_reason = NULL WHERE id = $1`,
      [connectionId],
    );
    expect((await listConnections(org)).find((c) => c.id === connectionId)?.status).toBe(
      'needs_reconnect',
    );
    expect((await call('DELETE', `${base(org)}/${connectionId}`, org.owner)).status).toBe(204);
    expect((await listConnections(org)).map((c) => c.id)).not.toContain(connectionId);
    const row = await api.pool.query(`SELECT status, status_reason FROM connection WHERE id = $1`, [
      connectionId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'revoked', status_reason: 'user_disconnected' });
    const disconnected = await api.pool.query<{ sequence: string; actor_user_id: string }>(
      `SELECT sequence, actor_user_id FROM audit_event
        WHERE subject_id = $1 AND action = 'connection.disconnected'`,
      [connectionId],
    );
    expect(disconnected.rows).toHaveLength(1);
    expect(disconnected.rows[0]!.actor_user_id).toBe(org.owner.userId);
    const teardown = { op: 'teardown', nonce: `${connectionId}:${disconnected.rows[0]!.sequence}` };
    const teardowns = async () =>
      (await lifecycleJobs(connectionId!)).filter((p) => p.op === 'teardown');
    expect(await teardowns()).toEqual([teardown]);
    expect((await call('DELETE', `${base(org)}/${connectionId}`, org.owner)).status).toBe(204);
    expect(await teardowns()).toEqual([teardown]);
    expect((await call('DELETE', `${base(other)}/${connectionId}`, other.owner)).status).toBe(404);
  });

  it('no response body or log line contains any FakeGraph-issued secret', () => {
    const secrets = graph.issuedSecrets();
    expect(secrets.length).toBeGreaterThan(5);
    const responses = seen.map((r) => JSON.stringify([r.body, r.headers]));
    for (const s of secrets) {
      for (const text of [...responses, ...api.logLines]) expect(text).not.toContain(s);
    }
  });
});
