// GET /v1/actions/{id} and GET /v1/key.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { ActionResource, KeyResource, PgApiKeys } from '@feedbouncer/public-api';
import { Secret } from '@feedbouncer/service-runtime';
import { runExecuteJob } from '../testing/execute.js';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const APP_ID = '1112223334';
const FACEBOOK = {
  appId: APP_ID,
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};

let api: TestApi;
let graph: FakeGraph;
let A: OrgFixture;
let keys: PgApiKeys;
let ipCounter = 0;

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'x-forwarded-for': `198.51.100.${(++ipCounter % 250) + 1}`,
});
const get = (path: string, token: string) => api.req('GET', path, { headers: headers(token) });

async function newKey(scope: 'read' | 'write', name = `k-${randomUUID()}`) {
  const { key, token } = await keys.create(A.orgId, A.owner.userId, { name, scope });
  return { id: key.id, name, token: token.reveal() };
}

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi({ facebook: FACEBOOK, trustProxyHops: 1 }, { fetch: graph.fetch });
  A = await orgWithRoles(api, 'actA');
  keys = new PgApiKeys(api.pool);
});
afterAll(() => api.close());

describe('GET /v1/actions/{id}', () => {
  it('returns hide actions too, and only the kinds the API exposes', async () => {
    const { pageId, pageToken } = graph.addPage(graph.addUser('Dana').userId, { name: 'Shop' });
    const { rows } = await api.pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, 'facebook', $3, 'active') RETURNING id`,
      [A.orgId, A.brandId, pageId],
    );
    const scope = { organizationId: A.orgId, brandId: A.brandId, connectionId: rows[0]!.id };
    await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
    const c = graph.addComment(pageId, { message: 'hello', createdAtMs: Date.now() });
    const stored = await api.deps.comments!.store.upsertFromPlatform(
      scope,
      {
        externalId: c.commentId,
        sourceExternalId: c.postId,
        parentExternalId: null,
        author: { externalId: '3000000001', displayName: 'Author', profileUrl: null },
        body: 'hello',
        postedAt: new Date(),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: pageId, syncedAt: new Date() },
    );
    const writer = await newKey('write');
    const hide = await api.req('POST', `/v1/comments/${stored.commentId}/hide`, {
      headers: headers(writer.token),
    });
    await runExecuteJob(api, hide.body.action.id, scope);
    const got = await get(`/v1/actions/${hide.body.action.id}`, writer.token);
    expect(got.status).toBe(200);
    expect(ActionResource.parse(got.body)).toMatchObject({
      kind: 'hide',
      commentId: stored.commentId,
      status: 'applied',
    });

    const other = await api.pool.query<{ id: string }>(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'delete', 'system', $5, 'noop', now()) RETURNING id`,
      [A.orgId, A.brandId, scope.connectionId, stored.commentId, `t-${randomUUID()}`],
    );
    expect((await get(`/v1/actions/${other.rows[0]!.id}`, writer.token)).status).toBe(404);
  });

  it('answers 401 without a key', async () => {
    const r = await api.req('GET', `/v1/actions/${randomUUID()}`);
    expect(r.status).toBe(401);
  });
});

describe('GET /v1/key', () => {
  it('returns the organization, name and scope, and nothing secret', async () => {
    const k = await newKey('read', 'Reporting bot');
    const r = await get('/v1/key', k.token);
    expect(r.status).toBe(200);
    expect(KeyResource.parse(r.body)).toEqual({
      organizationId: A.orgId,
      name: 'Reporting bot',
      scope: 'read',
    });
    expect(JSON.stringify(r.body)).not.toContain('fbk_');
    expect(JSON.stringify(r.body)).not.toContain(k.id);
  });

  it('works for a write key too', async () => {
    const k = await newKey('write');
    expect((await get('/v1/key', k.token)).body).toMatchObject({ scope: 'write' });
  });
});
