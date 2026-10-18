// The Facebook connect flow end to end over the API, with FakeGraph as the
// platform behind SafeHttp: authorize -> consent -> callback -> select -> connect.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { INGEST_JOB } from '@feedbouncer/comments';
import type { Platform } from '@feedbouncer/connectors';
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
const INSTAGRAM = { meta: FACEBOOK };
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let api: TestApi;
let graph: FakeGraph;
let org: OrgFixture;
let other: OrgFixture;
let fbUserId: string;
/** Every response seen, for the secret-leak check at the end. */
const seen: TestResponse[] = [];
/** Every OAuth state issued, with the authorize response that carried it. */
const states: { state: string; carrier: TestResponse }[] = [];

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi(
    {
      facebook: FACEBOOK,
      instagram: INSTAGRAM,
      metaAds: { meta: FACEBOOK, activeStatuses: ['ACTIVE'] },
    },
    { fetch: graph.fetch },
  );
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

async function authorize(
  f: OrgFixture,
  user: TestUser,
  body: unknown = {},
  platform: Platform = 'facebook',
): Promise<URL> {
  const r = await call('POST', `${base(f)}/${platform}/authorize`, user, body);
  expect(r.status).toBe(200);
  const url = new URL(r.body.authorizationUrl);
  expect(url.hostname).toBe('www.facebook.com');
  states.push({ state: url.searchParams.get('state')!, carrier: r });
  return url;
}

const callback = (
  user: TestUser,
  c: { code: string; state: string },
  platform: Platform = 'facebook',
) =>
  call(
    'GET',
    `/api/v1/oauth/${platform}/callback?code=${encodeURIComponent(c.code)}&state=${c.state}`,
    user,
  );

/** authorize -> consent -> callback; returns the grant id from the redirect. */
async function grantFor(
  f: OrgFixture,
  body: unknown = {},
  platform: Platform = 'facebook',
  userId = fbUserId,
): Promise<string> {
  const url = await authorize(f, f.owner, body, platform);
  const r = await callback(f.owner, graph.consent(url, userId), platform);
  expect(r.status).toBe(302);
  const location = String(r.headers.location);
  const m = new RegExp(
    `^${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections/${platform}/select\\?grant=(${UUID_RE})$`,
  ).exec(location);
  expect(m, location).not.toBeNull();
  return m![1]!;
}

async function connect(
  f: OrgFixture,
  grantId: string,
  accountIds: string[],
  platform: Platform = 'facebook',
) {
  const r = await call('POST', `${base(f)}/${platform}/grants/${grantId}/connect`, f.owner, {
    accountIds,
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
      backfill: expect.objectContaining({ status: 'pending' }),
      reviewMode: expect.objectContaining({ connectionId, state: 'active', pendingCount: 0 }),
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
      accountIds: [pageId],
    });
    spy.mockRestore();
    expect(r.status).toBe(503);

    const listed = (await listConnections(org)).find((c) => c.externalAccountId === pageId);
    expect(listed).toMatchObject({ status: 'needs_reconnect', statusReason: 'setup_not_queued' });

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
      `/api/v1/oauth/facebook/callback?error=access_denied&error_reason=user_denied&state=${denied.searchParams.get('state')}`,
      org.owner,
    );
    expect(d.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=denied`,
    );
    const refused = await authorize(org, org.owner);
    const r = await call(
      'GET',
      `/api/v1/oauth/facebook/callback?error=access_denied&state=${refused.searchParams.get('state')}`,
      org.owner,
    );
    expect(r.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=provider_error`,
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
      accountIds: [pageId],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      results: [
        {
          externalAccountId: pageId,
          status: 'connected_elsewhere',
          connectionId: null,
          wasReconnectRequired: false,
          reviewMode: null,
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
      accountIds: ['1'],
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
    await bad(grant, { accountIds: [] }, 400);
    await bad(grant, { accountIds: ['../me'] }, 400);
    await bad(grant, { accountIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) }, 400);
    await bad(grant, { accountIds: ['1'] }, 404);
    await bad(`${base(org)}/facebook/grants/nope/connect`, { accountIds: ['1'] }, 404);
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
    expect((await listConnections(org)).find((c) => c.id === connectionId)?.status).toBe('error');
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

  it('member role cannot authorize (403); owner and admin can', async () => {
    for (const platform of ['facebook', 'instagram'] as const) {
      const denied = await call('POST', `${base(org)}/${platform}/authorize`, org.member, {});
      expect(denied.status, platform).toBe(403);
      expect(denied.body).toEqual({
        error: { code: 'forbidden', message: expect.any(String) as string },
      });
      expect(JSON.stringify(denied.body)).not.toContain('www.facebook.com');
      for (const user of [org.owner, org.admin]) await authorize(org, user, {}, platform);
    }
  });
});

describe('instagram connect flow', () => {
  /** A Page of Dana's linked to an IG professional account. */
  function linkedAccount(name: string, username: string) {
    const { pageId, pageToken } = graph.addPage(fbUserId, { name });
    const { igUserId } = graph.addInstagramAccount(pageId, { username });
    return { pageId, pageToken, igUserId };
  }

  it('instagram: authorize -> callback -> select lists linked accounts -> connect creates one instagram connection and enqueues setup', async () => {
    const { igUserId, pageToken } = linkedAccount('Shop IG', 'shop.ig');
    const url = await authorize(org, org.owner, {}, 'instagram');
    expect(url.searchParams.get('redirect_uri')).toBe(`${WEB}/api/v1/oauth/instagram/callback`);
    expect(url.searchParams.get('scope')!.split(',')).toEqual(
      expect.arrayContaining(['instagram_basic', 'instagram_manage_comments']),
    );
    const cb = await callback(org.owner, graph.consent(url, fbUserId), 'instagram');
    expect(cb.status).toBe(302);
    const grantId = new RegExp(
      `^${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections/instagram/select\\?grant=(${UUID_RE})$`,
    ).exec(String(cb.headers.location))![1]!;

    const g = await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.owner);
    expect(g.status).toBe(200);
    expect(g.body.accounts).toContainEqual({
      externalAccountId: igUserId,
      displayName: '@shop.ig (via Shop IG)',
      eligible: true,
      ineligibleReason: null,
      limitations: [],
      connection: null,
    });

    const [res] = await connect(org, grantId, [igUserId], 'instagram');
    expect(res).toMatchObject({ externalAccountId: igUserId, status: 'connected' });
    const connectionId = res!.connectionId!;
    const rows = await api.pool.query(
      `SELECT id, platform, brand_id FROM connection WHERE external_account_id = $1`,
      [igUserId],
    );
    expect(rows.rows).toEqual([{ id: connectionId, platform: 'instagram', brand_id: org.brandId }]);
    expect(await listConnections(org)).toContainEqual(
      expect.objectContaining({
        id: connectionId,
        platform: 'instagram',
        externalAccountId: igUserId,
        status: 'connected',
      }),
    );
    const secret = await api.pool.query<{ encrypted_value: Buffer }>(
      `SELECT encrypted_value FROM connection_secret WHERE connection_id = $1 AND kind = 'access_token'`,
      [connectionId],
    );
    expect(secret.rows).toHaveLength(1);
    expect(secret.rows[0]!.encrypted_value.includes(Buffer.from(pageToken))).toBe(false);
    const setup = await api.pool.query<{ platform: string; payload: { op: string } }>(
      `SELECT platform, payload FROM job_ledger
        WHERE connection_id = $1 AND job_type = 'connection_lifecycle'`,
      [connectionId],
    );
    expect(setup.rows).toEqual([
      { platform: 'instagram', payload: expect.objectContaining({ op: 'setup' }) as unknown },
    ]);
    // Single-use grant; and a facebook path cannot read an instagram grant.
    expect((await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.owner)).status).toBe(
      404,
    );
  });

  it('a grant is bound to its platform: the facebook path cannot read or spend an instagram grant', async () => {
    const { igUserId } = linkedAccount('Bound', 'bound');
    const grantId = await grantFor(org, {}, 'instagram');
    expect((await call('GET', `${base(org)}/facebook/grants/${grantId}`, org.owner)).status).toBe(
      404,
    );
    const spent = await call('POST', `${base(org)}/facebook/grants/${grantId}/connect`, org.owner, {
      accountIds: [igUserId],
    });
    expect(spent.status).toBe(404);
    expect((await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.owner)).status).toBe(
      200,
    );
  });

  it('instagram: a page without a linked IG account is listed ineligible; connecting it returns not_eligible and creates no connection row', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'No IG' });
    const grantId = await grantFor(org, {}, 'instagram');
    const g = await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.owner);
    expect(g.body.accounts).toContainEqual({
      externalAccountId: pageId,
      displayName: 'No IG',
      eligible: false,
      ineligibleReason: 'no_linked_instagram_account',
      limitations: [],
      connection: null,
    });
    const results = await connect(org, grantId, [pageId], 'instagram');
    expect(results).toEqual([
      {
        externalAccountId: pageId,
        status: 'not_eligible',
        connectionId: null,
        wasReconnectRequired: false,
        reviewMode: null,
      },
    ]);
    const rows = await api.pool.query(`SELECT id FROM connection WHERE external_account_id = $1`, [
      pageId,
    ]);
    expect(rows.rows).toEqual([]);
  });

  it('instagram: reconnect after token expiry updates the same row (no duplicate) and replays needs_reconnection dead letters', async () => {
    const { igUserId } = linkedAccount('Cafe IG', 'cafe.ig');
    const first = (
      await connect(org, await grantFor(org, {}, 'instagram'), [igUserId], 'instagram')
    )[0]!;
    const connectionId = first.connectionId!;
    const scope = { organizationId: org.orgId, brandId: org.brandId, connectionId };
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [connectionId],
    );
    const job = await api.deps.producer!.enqueue({
      scope,
      platform: 'instagram',
      type: INGEST_JOB.type,
      payload: {
        sourceExternalId: '17900000000000001',
        commentExternalId: '17900000000000002',
        event: 'created',
        platformEventSec: 1_760_000_000,
        changeId: 'fedcba9876543210',
      },
    });
    await api.pool.query(
      `UPDATE job_ledger SET state = 'dead_lettered', dead_letter_reason = 'needs_reconnection',
              dead_lettered_at = now(), last_error_kind = 'needs_reconnection',
              last_error_code = 'oauth_access_rejected'
        WHERE id = $1`,
      [job.ledgerId],
    );

    const grantId = await grantFor(org, { reconnectConnectionId: connectionId }, 'instagram');
    const [again] = await connect(org, grantId, [igUserId], 'instagram');
    expect(again).toMatchObject({
      status: 'reconnected',
      connectionId,
      wasReconnectRequired: true,
    });
    const rows = await api.pool.query(
      `SELECT id, status, status_reason FROM connection
        WHERE platform = 'instagram' AND external_account_id = $1`,
      [igUserId],
    );
    expect(rows.rows).toEqual([{ id: connectionId, status: 'active', status_reason: null }]);
    const ledger = await api.pool.query(`SELECT state, replays FROM job_ledger WHERE id = $1`, [
      job.ledgerId,
    ]);
    expect(ledger.rows[0]).toEqual({ state: 'queued', replays: 1 });
    expect((await lifecycleJobs(connectionId)).map((p) => p.op)).toEqual(['setup', 'setup']);
  });

  it('instagram: same IG account in another org -> connected_elsewhere, no row, no hint of the other org', async () => {
    const { igUserId } = linkedAccount('Shared IG', 'shared.ig');
    const mine = (
      await connect(org, await grantFor(org, {}, 'instagram'), [igUserId], 'instagram')
    )[0]!;
    expect(mine.status).toBe('connected');
    const grantId = await grantFor(other, {}, 'instagram');
    const g = await call('GET', `${base(other)}/instagram/grants/${grantId}`, other.owner);
    expect(g.body.accounts).toContainEqual(
      expect.objectContaining({ externalAccountId: igUserId, connection: 'elsewhere' }),
    );
    const r = await call(
      'POST',
      `${base(other)}/instagram/grants/${grantId}/connect`,
      other.owner,
      {
        accountIds: [igUserId],
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      results: [
        {
          externalAccountId: igUserId,
          status: 'connected_elsewhere',
          connectionId: null,
          wasReconnectRequired: false,
          reviewMode: null,
        },
      ],
    });
    for (const leak of [org.orgId, org.brandId, mine.connectionId!])
      expect(JSON.stringify([g.body, r.body])).not.toContain(leak);
    const rows = await api.pool.query(
      `SELECT organization_id FROM connection WHERE external_account_id = $1`,
      [igUserId],
    );
    expect(rows.rows).toEqual([{ organization_id: org.orgId }]);
  });

  it('unknown platform in the path -> 404 platform_not_configured', async () => {
    const notConfigured = {
      error: { code: 'platform_not_configured', message: expect.any(String) },
    };
    const grant = '00000000-0000-4000-8000-000000000000';
    for (const platform of ['tiktok', 'nope', 'FACEBOOK']) {
      const p = encodeURIComponent(platform);
      const a = await call('POST', `${base(org)}/${p}/authorize`, org.owner, {});
      expect(a.status, platform).toBe(404);
      expect(a.body).toEqual(notConfigured);
      const g = await call('GET', `${base(org)}/${p}/grants/${grant}`, org.owner);
      expect(g.body, platform).toEqual(notConfigured);
      const c = await call('POST', `${base(org)}/${p}/grants/${grant}/connect`, org.owner, {
        accountIds: ['1'],
      });
      expect(c.body, platform).toEqual(notConfigured);
      const cb = await call('GET', `/api/v1/oauth/${p}/callback?code=c&state=s`, org.owner);
      expect(cb.status, platform).toBe(404);
      expect(cb.body).toEqual(notConfigured);
    }
  });

  it('instagram disabled -> /connections/instagram/authorize is 404 platform_not_configured', async () => {
    const fbOnly = await startTestApi({ facebook: FACEBOOK }, { fetch: graph.fetch });
    try {
      const f = await orgWithRoles(fbOnly, 'fbonly');
      const notConfigured = {
        error: { code: 'platform_not_configured', message: expect.any(String) },
      };
      const url = `/api/v1/orgs/${f.orgId}/brands/${f.brandId}/connections`;
      const a = await fbOnly.req('POST', `${url}/instagram/authorize`, {
        cookie: f.owner.cookie,
        body: {},
      });
      expect(a.status).toBe(404);
      expect(a.body).toEqual(notConfigured);
      const cb = await fbOnly.req('GET', '/api/v1/oauth/instagram/callback?code=c&state=s', {
        cookie: f.owner.cookie,
      });
      expect(cb.status).toBe(404);
      expect(cb.body).toEqual(notConfigured);
      const fb = await fbOnly.req('POST', `${url}/facebook/authorize`, {
        cookie: f.owner.cookie,
        body: {},
      });
      expect(fb.status).toBe(200);
    } finally {
      await fbOnly.close();
    }
  });

  it('instagram: member role cannot read or spend a grant (403)', async () => {
    const grantId = await grantFor(org, {}, 'instagram');
    expect((await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.member)).status).toBe(
      403,
    );
    const c = await call('POST', `${base(org)}/instagram/grants/${grantId}/connect`, org.member, {
      accountIds: ['1'],
    });
    expect(c.status).toBe(403);
    expect((await call('GET', `${base(org)}/instagram/grants/${grantId}`, org.owner)).status).toBe(
      200,
    );
  });
});

describe('meta ads connect flow', () => {
  it('meta_ads connect lists ad accounts and creates one connection per selected account', async () => {
    const first = graph.addAdAccount(fbUserId, { name: 'Shop ads' }).adAccountId;
    const second = graph.addAdAccount(fbUserId, { name: 'Brand ads' }).adAccountId;
    const url = await authorize(org, org.owner, {}, 'meta_ads');
    expect(url.searchParams.get('scope')!.split(',')).toEqual(['ads_read']);
    const cb = await callback(org.owner, graph.consent(url, fbUserId), 'meta_ads');
    expect(cb.status).toBe(302);
    const grantId = new RegExp(
      `^${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections/meta_ads/select\\?grant=(${UUID_RE})$`,
    ).exec(String(cb.headers.location))![1]!;
    const g = await call('GET', `${base(org)}/meta_ads/grants/${grantId}`, org.owner);
    expect(g.status).toBe(200);
    const ids = (g.body.accounts as { externalAccountId: string }[]).map(
      (a) => a.externalAccountId,
    );
    expect(ids).toEqual(expect.arrayContaining([first, second]));

    const results = await connect(org, grantId, [first, second], 'meta_ads');
    expect(results.map((r) => r.status)).toEqual(['connected', 'connected']);
    const rows = await api.pool.query(
      `SELECT platform FROM connection WHERE brand_id = $1 AND external_account_id = ANY($2::text[])`,
      [org.brandId, [first, second]],
    );
    expect(rows.rows).toEqual([{ platform: 'meta_ads' }, { platform: 'meta_ads' }]);
  });

  it('declining ads_read creates nothing and reports the missing scope', async () => {
    const before = await api.pool.query('SELECT id FROM connection');
    const url = await authorize(org, org.owner, {}, 'meta_ads');
    const r = await callback(
      org.owner,
      graph.consent(url, fbUserId, { decline: ['ads_read'] }),
      'meta_ads',
    );
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(
      `${WEB}/orgs/${org.orgId}/brands/${org.brandId}/connections?error=missing_permissions&missing=ads_read`,
    );
    expect((await api.pool.query('SELECT id FROM connection')).rows).toEqual(before.rows);
  });
});

const backfillJobs = async (connectionId: string) =>
  (
    await api.pool.query<{ payload: { runId: string; segment: number } }>(
      `SELECT payload FROM job_ledger WHERE connection_id = $1 AND job_type = 'connection_backfill'
        ORDER BY created_at`,
      [connectionId],
    )
  ).rows;

const backfillOf = async (f: OrgFixture, connectionId: string) =>
  (
    (await call('GET', base(f), f.owner)).body.connections as { id: string; backfill: unknown }[]
  ).find((c) => c.id === connectionId)?.backfill;

describe('backfill on connect', () => {
  it('connecting queues one backfill without calling the platform feed', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf1' });
    const before = graph.calls().length;
    const { connectionId } = await connectPage(org, pageId);
    const jobs = await backfillJobs(connectionId!);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ segment: 0 });
    expect(
      graph
        .calls()
        .slice(before)
        .some((c) => c.path.includes('/feed')),
    ).toBe(false);
  });

  it('connecting twice queues one backfill', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf2' });
    const a = await connectPage(org, pageId);
    const b = await connectPage(org, pageId, { reconnectConnectionId: a.connectionId });
    expect(b.connectionId).toBe(a.connectionId);
    expect(await backfillJobs(a.connectionId!)).toHaveLength(1);
  });

  it('reconnecting after a completed run with an outage queues a gap run', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf3' });
    const a = await connectPage(org, pageId);
    const id = a.connectionId!;
    await api.pool.query(
      `UPDATE connection_backfill SET status = 'completed', completed_at = now(), synced_through = window_end
        WHERE connection_id = $1`,
      [id],
    );
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [id],
    );
    await api.pool.query(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
       SELECT organization_id, brand_id, 'system', 'connection.reconnect_required', 'connection', id, now() FROM connection WHERE id = $1`,
      [id],
    );
    await connectPage(org, pageId, { reconnectConnectionId: id });
    expect(await backfillJobs(id)).toHaveLength(2);
    const row = (
      await api.pool.query(
        `SELECT window_start, window_end FROM connection_backfill WHERE connection_id = $1`,
        [id],
      )
    ).rows[0];
    expect(row.window_end.getTime() - row.window_start.getTime()).toBeLessThan(3_600_000 + 60_000);
  });

  it('reconnecting after a completed run without an outage queues nothing', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf4' });
    const a = await connectPage(org, pageId);
    const id = a.connectionId!;
    await api.pool.query(
      `UPDATE connection_backfill SET status = 'completed', completed_at = now(), synced_through = window_end
        WHERE connection_id = $1`,
      [id],
    );
    await connectPage(org, pageId, { reconnectConnectionId: id });
    expect(await backfillJobs(id)).toHaveLength(1);
  });

  it('a backfill that cannot be queued fails the connect like setup', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf5' });
    const grantId = await grantFor(org);
    const real = api.deps.producer!.enqueue.bind(api.deps.producer!);
    const spy = vi.spyOn(api.deps.producer!, 'enqueue').mockImplementation(async (job) => {
      if (job.type === 'connection_backfill') throw new Error('down');
      return real(job);
    });
    const r = await call('POST', `${base(org)}/facebook/grants/${grantId}/connect`, org.owner, {
      accountIds: [pageId],
    });
    spy.mockRestore();
    expect(r.status).toBe(503);
    const listed = (await listConnections(org)).find((c) => c.externalAccountId === pageId);
    expect(listed).toMatchObject({ status: 'needs_reconnect', statusReason: 'setup_not_queued' });
  });

  it('disconnect cancels the backfill', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf6' });
    const { connectionId } = await connectPage(org, pageId);
    const del = await call('DELETE', `${base(org)}/${connectionId}`, org.owner);
    expect(del.status).toBe(204);
    const row = await api.pool.query(
      `SELECT status, failure_reason FROM connection_backfill WHERE connection_id = $1`,
      [connectionId],
    );
    expect(row.rows[0]).toEqual({ status: 'failed', failure_reason: 'cancelled' });
  });

  it('lists the backfill status with the connection', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf7' });
    const { connectionId } = await connectPage(org, pageId);
    expect(await backfillOf(org, connectionId!)).toEqual({
      status: 'pending',
      importedCount: 0,
      completedAt: null,
      limitedTo: null,
      nothingToImport: false,
      failureReason: null,
      skippedSources: 0,
    });
  });

  it('a stale run is reported as failed', async () => {
    const { pageId } = graph.addPage(fbUserId, { name: 'Bf8' });
    const { connectionId } = await connectPage(org, pageId);
    await api.pool.query(
      `UPDATE connection_backfill SET heartbeat_at = now() - interval '27 hours' WHERE connection_id = $1`,
      [connectionId],
    );
    expect(await backfillOf(org, connectionId!)).toMatchObject({
      status: 'failed',
      failureReason: 'stalled',
    });
  });
});

describe('secrets', () => {
  it('no token, code, state or grant token appears in any response body or log line', () => {
    const secrets = graph.issuedSecrets();
    expect(secrets.length).toBeGreaterThan(5);
    const texts = (rs: TestResponse[]) => rs.map((r) => JSON.stringify([r.body, r.headers]));
    const responses = texts(seen);
    for (const s of secrets) {
      for (const text of [...responses, ...api.logLines]) expect(text).not.toContain(s);
    }
    // A state is handed out once, inside its authorization URL, and never again.
    expect(states.length).toBeGreaterThan(5);
    for (const { state, carrier } of states) {
      for (const text of [...texts(seen.filter((r) => r !== carrier)), ...api.logLines])
        expect(text).not.toContain(state);
    }
    const grantTokens = api.logLines.filter((l) => /user[-_]?token/i.test(l));
    expect(grantTokens).toEqual([]);
  });
});
