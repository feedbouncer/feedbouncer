// POST /v1/comments/{id}/hide and /unhide. Comments are stored the way the ingest job stores
// them; the execute job runs inline against FakeGraph (the worker runs it in production).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { ModerationResult, PgApiKeys } from '@feedbouncer/public-api';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { runExecuteJob } from '../testing/execute.js';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';
import { upsertStored } from '@feedbouncer/comments/testing';

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

async function comment(
  p: { pageId: string; scope: ConnectionScope },
  state: 'visible' | 'hidden' = 'visible',
) {
  const c = graph.addComment(p.pageId, { message: 'hello', createdAtMs: Date.now() });
  const authorId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const r = await upsertStored(
    api.deps.comments!.store,
    p.scope,
    {
      externalId: c.commentId,
      sourceExternalId: c.postId,
      parentExternalId: null,
      author: { externalId: authorId, displayName: `Author ${authorId}`, profileUrl: null },
      body: 'hello',
      postedAt: new Date(),
      platformState: state,
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

function post(path: string, opts: { token?: string; idem?: string; body?: unknown } = {}) {
  return api.req('POST', path, {
    headers: {
      authorization: `Bearer ${opts.token ?? writer.token}`,
      'x-forwarded-for': `203.0.113.${(++ipCounter % 250) + 1}`,
      ...(opts.idem !== undefined && { 'idempotency-key': opts.idem }),
    },
    ...(opts.body !== undefined && { body: opts.body }),
  });
}

const actionRows = (commentId: string) =>
  api.pool
    .query(`SELECT * FROM moderation_action WHERE comment_id = $1 ORDER BY created_at, id`, [
      commentId,
    ])
    .then((r) => r.rows);

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi({ facebook: FACEBOOK, trustProxyHops: 1 }, { fetch: graph.fetch });
  A = await orgWithRoles(api, 'modA');
  B = await orgWithRoles(api, 'modB');
  pageA = await connectedPage(A, graph.addUser('Dana').userId);
  pageB = await connectedPage(B, graph.addUser('Eli').userId);
  keys = new PgApiKeys(api.pool);
  writer = await newKey(A, 'write');
});
afterAll(() => api.close());

describe('POST /v1/comments/{id}/hide', () => {
  it('hides a visible comment: 202 pending, api_key actor on the action; the job applies it and audits the key', async () => {
    const c = await comment(pageA);
    const r = await post(`/v1/comments/${c.id}/hide`);
    expect(r.status).toBe(202);
    expect(ModerationResult.parse(r.body)).toMatchObject({
      action: { kind: 'hide', status: 'pending', code: null },
      comment: { id: c.id },
    });
    const [row] = await actionRows(c.id);
    expect(row).toMatchObject({
      id: r.body.action.id,
      actor_type: 'api_key',
      actor_api_key_id: writer.id,
      actor_user_id: null,
    });

    await runExecuteJob(api, r.body.action.id, pageA.scope);
    expect(graph.state(c.externalId)).toBe('hidden');
    const audit = await api.pool.query(
      `SELECT actor_type, actor_user_id, details FROM audit_event
        WHERE organization_id = $1 AND subject_id = $2 AND action = 'comment.moderated'`,
      [A.orgId, c.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'api_key',
        actor_user_id: null,
        details: expect.objectContaining({
          actionId: r.body.action.id,
          status: 'applied',
          apiKeyId: writer.id,
        }) as unknown,
      },
    ]);
    const after = await api.req('GET', `/v1/comments/${c.id}`, {
      headers: { authorization: `Bearer ${writer.token}`, 'x-forwarded-for': '203.0.113.250' },
    });
    expect(after.body).toMatchObject({ id: c.id, status: 'hidden' });
  });

  it('replays the stored response for the same Idempotency-Key: same action, header set, one row', async () => {
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    const first = await post(`/v1/comments/${c.id}/hide`, { idem });
    const second = await post(`/v1/comments/${c.id}/hide`, { idem });
    expect(first.status).toBe(202);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(second.body.action.id).toBe(first.body.action.id);
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('serializes concurrent requests with one key into one action', async () => {
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    const results = await Promise.all(
      [1, 2, 3].map(() => post(`/v1/comments/${c.id}/hide`, { idem })),
    );
    for (const r of results) expect([202, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 202)).toBe(true);
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('derives the request key from the API key and a hash of the Idempotency-Key, never the raw value', async () => {
    const c = await comment(pageA);
    const idem = `raw-${randomUUID()}`;
    await post(`/v1/comments/${c.id}/hide`, { idem });
    const [row] = await actionRows(c.id);
    expect(row.request_key).toMatch(new RegExp(`^api:${writer.id}:[0-9a-f]{32}$`));
    expect(row.request_key).not.toContain(idem);
  });

  it('without an Idempotency-Key each call is its own request', async () => {
    const c = await comment(pageA);
    const first = await post(`/v1/comments/${c.id}/hide`);
    const second = await post(`/v1/comments/${c.id}/hide`);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.action.id).not.toBe(first.body.action.id);
  });

  it('reusing an Idempotency-Key for another comment -> 422 idempotency_key_reused, nothing hidden', async () => {
    const one = await comment(pageA);
    const two = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    expect((await post(`/v1/comments/${one.id}/hide`, { idem })).status).toBe(202);
    const r = await post(`/v1/comments/${two.id}/hide`, { idem });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_key_reused');
    expect(await actionRows(two.id)).toHaveLength(0);
  });

  it('the same Idempotency-Key from two keys of one org runs two independent requests', async () => {
    const other = await newKey(A, 'write');
    const c = await comment(pageA);
    const idem = `shared-${randomUUID()}`;
    const first = await post(`/v1/comments/${c.id}/hide`, { idem });
    const second = await post(`/v1/comments/${c.id}/hide`, { idem, token: other.token });
    expect(first.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body.action.id).not.toBe(first.body.action.id);
    const rows = await actionRows(c.id);
    expect(rows.map((r) => r.actor_api_key_id).sort()).toEqual([writer.id, other.id].sort());
  });

  it('hiding an already hidden comment -> 200 noop already_hidden', async () => {
    const c = await comment(pageA, 'hidden');
    const r = await post(`/v1/comments/${c.id}/hide`);
    expect(r.status).toBe(200);
    expect(ModerationResult.parse(r.body).action).toMatchObject({
      status: 'noop',
      code: 'already_hidden',
    });
    const audit = await api.pool.query(
      `SELECT actor_type, details FROM audit_event WHERE subject_id = $1 AND action = 'comment.moderated'`,
      [c.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'api_key',
        details: expect.objectContaining({ apiKeyId: writer.id, status: 'noop' }) as unknown,
      },
    ]);
  });

  it('a read key -> 403 insufficient_scope and nothing is stored', async () => {
    const reader = await newKey(A, 'read');
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    const r = await post(`/v1/comments/${c.id}/hide`, { token: reader.token, idem });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('insufficient_scope');
    expect(await actionRows(c.id)).toHaveLength(0);
    const rec = await api.pool.query('SELECT 1 FROM api_idempotency_record WHERE api_key_id = $1', [
      reader.id,
    ]);
    expect(rec.rowCount).toBe(0);
  });

  it("another organization's comment -> 404, and it stays untouched", async () => {
    const c = await comment(pageB);
    const r = await post(`/v1/comments/${c.id}/hide`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
    expect(await actionRows(c.id)).toHaveLength(0);
  });

  it('an unknown, malformed or platform-deleted comment -> 404', async () => {
    const c = await comment(pageA);
    await api.pool.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c.id]);
    for (const id of [randomUUID(), 'not-a-uuid', c.id])
      expect((await post(`/v1/comments/${id}/hide`)).status, id).toBe(404);
    expect(await actionRows(c.id)).toHaveLength(0);
  });

  it('stores a 404 under the key and replays it', async () => {
    const id = randomUUID();
    const idem = `i-${randomUUID()}`;
    const first = await post(`/v1/comments/${id}/hide`, { idem });
    const second = await post(`/v1/comments/${id}/hide`, { idem });
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('revoking the key makes a replay of its stored request 401, never the stored response', async () => {
    const doomed = await newKey(A, 'write');
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    const first = await post(`/v1/comments/${c.id}/hide`, { token: doomed.token, idem });
    expect(first.status).toBe(202);
    await keys.revoke(A.orgId, A.owner.userId, doomed.id);
    const replay = await post(`/v1/comments/${c.id}/hide`, { token: doomed.token, idem });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('unauthenticated');
    expect(JSON.stringify(replay.body)).not.toContain(first.body.action.id);
    expect(replay.headers['idempotent-replayed']).toBeUndefined();
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('rejects a malformed Idempotency-Key and any request body field', async () => {
    const c = await comment(pageA);
    const badKey = await post(`/v1/comments/${c.id}/hide`, { idem: 'has space' });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error.code).toBe('invalid_idempotency_key');
    const tooLong = await post(`/v1/comments/${c.id}/hide`, { idem: 'a'.repeat(129) });
    expect(tooLong.status).toBe(400);
    const extra = await post(`/v1/comments/${c.id}/hide`, { body: { reason: 'spam' } });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('invalid_request');
    const empty = await post(`/v1/comments/${c.id}/hide`, { body: {} });
    expect(empty.status).toBe(202);
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('answers 401 without a key and never creates an action', async () => {
    const c = await comment(pageA);
    const r = await api.req('POST', `/v1/comments/${c.id}/hide`, {
      headers: { 'x-forwarded-for': '203.0.113.251' },
    });
    expect(r.status).toBe(401);
    expect(await actionRows(c.id)).toHaveLength(0);
  });
});

describe('POST /v1/comments/{id}/unhide', () => {
  it('unhides a hidden comment: 202 pending, api_key actor; the job restores it', async () => {
    const c = await comment(pageA);
    const hide = await post(`/v1/comments/${c.id}/hide`);
    await runExecuteJob(api, hide.body.action.id, pageA.scope);
    const r = await post(`/v1/comments/${c.id}/unhide`);
    expect(r.status).toBe(202);
    expect(ModerationResult.parse(r.body).action).toMatchObject({
      kind: 'unhide',
      status: 'pending',
    });
    await runExecuteJob(api, r.body.action.id, pageA.scope);
    expect(graph.state(c.externalId)).toBe('visible');
    const rows = await actionRows(c.id);
    expect(rows.map((x) => [x.kind, x.actor_type, x.status])).toEqual([
      ['hide', 'api_key', 'applied'],
      ['unhide', 'api_key', 'applied'],
    ]);
  });

  it('unhiding a visible comment -> 200 noop already_visible', async () => {
    const c = await comment(pageA);
    const r = await post(`/v1/comments/${c.id}/unhide`);
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({
      kind: 'unhide',
      status: 'noop',
      code: 'already_visible',
    });
  });

  it("another organization's comment and a read key behave as for hide", async () => {
    const c = await comment(pageB);
    expect((await post(`/v1/comments/${c.id}/unhide`)).status).toBe(404);
    const reader = await newKey(A, 'read');
    const own = await comment(pageA, 'hidden');
    expect((await post(`/v1/comments/${own.id}/unhide`, { token: reader.token })).status).toBe(403);
    expect(await actionRows(own.id)).toHaveLength(0);
  });

  it('hide and unhide with one Idempotency-Key are different requests: 422', async () => {
    const c = await comment(pageA);
    const idem = `i-${randomUUID()}`;
    expect((await post(`/v1/comments/${c.id}/hide`, { idem })).status).toBe(202);
    expect((await post(`/v1/comments/${c.id}/unhide`, { idem })).status).toBe(422);
  });
});
