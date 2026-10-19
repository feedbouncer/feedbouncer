// POST /v1/comments/{id}/replies. Comments are stored the way the ingest job stores them; the
// execute job runs inline against FakeGraph (the worker runs it in production).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { ActionResource, PgApiKeys, ReplyResult } from '@feedbouncer/public-api';
import type { ConnectionScope } from '@feedbouncer/secrets';
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
let B: OrgFixture;
let pageA: { pageId: string; scope: ConnectionScope };
let pageB: { pageId: string; scope: ConnectionScope };
let keys: PgApiKeys;
let writer: { id: string; token: string };
let ipCounter = 0;

async function connectedPage(org: OrgFixture, fbUserId: string) {
  const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop' });
  const { rows } = await api.pool.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
     VALUES ($1, $2, 'facebook', $3, 'active') RETURNING id`,
    [org.orgId, org.brandId, pageId],
  );
  const scope = { organizationId: org.orgId, brandId: org.brandId, connectionId: rows[0]!.id };
  await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
  return { pageId, scope };
}

async function comment(p: { pageId: string; scope: ConnectionScope }) {
  const c = graph.addComment(p.pageId, { message: 'hello', createdAtMs: Date.now() });
  const authorId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const r = await api.deps.comments!.store.upsertFromPlatform(
    p.scope,
    {
      externalId: c.commentId,
      sourceExternalId: c.postId,
      parentExternalId: null,
      author: { externalId: authorId, displayName: `Author ${authorId}`, profileUrl: null },
      body: 'hello',
      postedAt: new Date(),
      platformState: 'visible',
      permalink: null,
    },
    { ownAccountExternalId: p.pageId, syncedAt: new Date() },
  );
  return { id: r.commentId, externalId: c.commentId };
}

async function newKey(org: OrgFixture, scope: 'read' | 'write') {
  const { key, token } = await keys.create(org.orgId, org.owner.userId, {
    name: `k-${randomUUID()}`,
    scope,
  });
  return { id: key.id, token: token.reveal() };
}

const headers = (token: string, idem?: string) => ({
  authorization: `Bearer ${token}`,
  'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
  ...(idem !== undefined && { 'idempotency-key': idem }),
});

const reply = (commentId: string, body: unknown, opts: { token?: string; idem?: string } = {}) =>
  api.req('POST', `/v1/comments/${commentId}/replies`, {
    headers: headers(opts.token ?? writer.token, opts.idem),
    body,
  });

const getAction = (id: string, token = writer.token) =>
  api.req('GET', `/v1/actions/${id}`, { headers: headers(token) });

const actionRows = (commentId: string) =>
  api.pool
    .query(`SELECT * FROM moderation_action WHERE comment_id = $1 ORDER BY created_at, id`, [
      commentId,
    ])
    .then((r) => r.rows);

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi(
    { facebook: FACEBOOK, instagram: { meta: FACEBOOK }, trustProxyHops: 1 },
    { fetch: graph.fetch },
  );
  A = await orgWithRoles(api, 'repA');
  B = await orgWithRoles(api, 'repB');
  pageA = await connectedPage(A, graph.addUser('Dana').userId);
  pageB = await connectedPage(B, graph.addUser('Eli').userId);
  keys = new PgApiKeys(api.pool);
  writer = await newKey(A, 'write');
});
afterAll(() => api.close());

describe('POST /v1/comments/{id}/replies', () => {
  it('queues the reply with 202; once the job ran, GET /v1/actions/{id} is applied with the platformRef', async () => {
    const c = await comment(pageA);
    const r = await reply(c.id, { text: 'Thanks for asking!' });
    expect(r.status).toBe(202);
    expect(ReplyResult.parse(r.body)).toMatchObject({
      action: { kind: 'public_reply', commentId: c.id, status: 'pending', platformRef: null },
      comment: { id: c.id },
    });
    const [row] = await actionRows(c.id);
    expect(row).toMatchObject({
      id: r.body.action.id,
      actor_type: 'api_key',
      actor_api_key_id: writer.id,
      reply_text: 'Thanks for asking!',
    });

    await runExecuteJob(api, r.body.action.id, pageA.scope);
    const got = await getAction(r.body.action.id);
    expect(got.status).toBe(200);
    expect(ActionResource.parse(got.body)).toMatchObject({
      id: r.body.action.id,
      kind: 'public_reply',
      status: 'applied',
      code: null,
      platformRef: expect.any(String) as unknown,
    });
    expect(graph.replies(c.externalId).map((x) => x.message)).toEqual(['Thanks for asking!']);
  });

  it('the same Idempotency-Key twice -> one action, one Graph comment, identical bodies', async () => {
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    const first = await reply(c.id, { text: 'once' }, { idem });
    const second = await reply(c.id, { text: 'once' }, { idem });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    await runExecuteJob(api, first.body.action.id, pageA.scope);
    expect(await actionRows(c.id)).toHaveLength(1);
    expect(graph.replies(c.externalId)).toHaveLength(1);
    const [row] = await actionRows(c.id);
    expect(row.request_key).toMatch(new RegExp(`^api:${writer.id}:[0-9a-f]{32}$`));
  });

  it('the same key with different text -> 422 idempotency_key_reused', async () => {
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    expect((await reply(c.id, { text: 'one' }, { idem })).status).toBe(202);
    const r = await reply(c.id, { text: 'two' }, { idem });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reused');
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('a read key -> 403 insufficient_scope and no action row', async () => {
    const reader = await newKey(A, 'read');
    const c = await comment(pageA);
    const r = await reply(c.id, { text: 'hi' }, { token: reader.token });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('insufficient_scope');
    expect(await actionRows(c.id)).toHaveLength(0);
  });

  it('text over the platform maximum -> 422 text_too_long with max; no action row, no Graph call', async () => {
    const { pageId, pageToken } = graph.addPage(graph.addUser('Ira').userId, { name: 'Shop IG' });
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' });
    const { scope } = await api.seedConnection(
      { orgId: A.orgId, brandId: A.brandId },
      { platform: 'instagram', externalAccountId: igUserId },
    );
    await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
    const ig = graph.addIgComment(igUserId, { text: 'hello', createdAtMs: Date.now() });
    const stored = await api.deps.comments!.store.upsertFromPlatform(
      scope,
      {
        externalId: ig.commentId,
        sourceExternalId: ig.mediaId,
        parentExternalId: null,
        author: { externalId: '17800000001', displayName: 'ig_fan', profileUrl: null },
        body: 'hello',
        postedAt: new Date(),
        platformState: 'visible',
        permalink: null,
      },
      { ownAccountExternalId: igUserId, syncedAt: new Date() },
    );
    const calls = graph.calls().length;
    const r = await reply(stored.commentId, { text: '🙂'.repeat(2201) });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'text_too_long', max: 2200 });
    expect(await actionRows(stored.commentId)).toHaveLength(0);
    expect(graph.calls()).toHaveLength(calls);
  });

  it('a platform without the public_reply capability -> 422 unsupported_action', async () => {
    const c = await comment(pageA);
    const registry = api.deps.connectors!.registry;
    const original = registry.get.bind(registry);
    const spy = vi
      .spyOn(registry, 'get')
      .mockImplementation((p) => (p === 'facebook' ? undefined : original(p)));
    try {
      const r = await reply(c.id, { text: 'hi' });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('unsupported_action');
    } finally {
      spy.mockRestore();
    }
    expect(await actionRows(c.id)).toHaveLength(0);
  });

  it('a connection that needs reconnecting -> 409 connection_inactive', async () => {
    const stale = await connectedPage(A, graph.addUser('Sam').userId);
    const c = await comment(stale);
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [stale.scope.connectionId],
    );
    const r = await reply(c.id, { text: 'hi' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connection_inactive');
  });

  it('Graph rejects the reply -> the action is failed with a code, and GET shows it', async () => {
    const c = await comment(pageA);
    const r = await reply(c.id, { text: 'will be refused' });
    graph.failNext(200);
    await runExecuteJob(api, r.body.action.id, pageA.scope);
    const got = await getAction(r.body.action.id);
    expect(got.body).toMatchObject({ id: r.body.action.id, status: 'failed', platformRef: null });
    expect(got.body.code).toEqual(expect.any(String));
    expect(graph.replies(c.externalId)).toHaveLength(0);
  });

  it('a comment deleted upstream -> the action ends noop with comment_gone', async () => {
    const c = await comment(pageA);
    graph.removeComment(c.externalId);
    const r = await reply(c.id, { text: 'too late' });
    expect(r.status).toBe(202);
    await runExecuteJob(api, r.body.action.id, pageA.scope);
    expect((await getAction(r.body.action.id)).body).toMatchObject({
      status: 'noop',
      code: 'comment_gone',
    });
  });

  it("another organization's comment and action -> 404", async () => {
    const mine = await comment(pageA);
    const theirs = await comment(pageB);
    const foreign = await reply(theirs.id, { text: 'hi' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('not_found');
    expect(await actionRows(theirs.id)).toHaveLength(0);

    const own = await reply(mine.id, { text: 'hi' });
    const other = await newKey(B, 'read');
    expect((await getAction(own.body.action.id, other.token)).status).toBe(404);
    expect((await getAction(randomUUID())).status).toBe(404);
    expect((await getAction('not-a-uuid')).status).toBe(404);
  });

  it('audits the reply as comment.moderated by the API key, without the text', async () => {
    const c = await comment(pageA);
    const r = await reply(c.id, { text: 'audit-secret-text-qz81' });
    await runExecuteJob(api, r.body.action.id, pageA.scope);
    const audit = await api.pool.query(
      `SELECT actor_type, details FROM audit_event
        WHERE organization_id = $1 AND subject_id = $2 AND action = 'comment.moderated'`,
      [A.orgId, c.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'api_key',
        details: expect.objectContaining({
          kind: 'public_reply',
          status: 'applied',
          apiKeyId: writer.id,
        }) as unknown,
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('audit-secret-text-qz81');
  });

  it('rejects empty, blank, oversized and unknown body fields', async () => {
    const c = await comment(pageA);
    for (const body of [
      {},
      { text: '' },
      { text: '  \n ' },
      { text: 'x'.repeat(8001) },
      { text: 'hi', kind: 'hide' },
    ]) {
      const r = await reply(c.id, body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    expect(await actionRows(c.id)).toHaveLength(0);
  });
});
