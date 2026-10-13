// Comment listing and moderation actions over the API. Comments are stored the
// way the ingest job stores them; the execute job is run inline against
// FakeGraph (the worker runs it in production).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { EXECUTE_JOB, executeActionJob } from '@feedbouncer/comments';
import type { JobContext } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
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
let org: OrgFixture;
let fbUserId: string;
let page: { pageId: string; scope: ConnectionScope };

/** An active Facebook connection for a FakeGraph Page, with its token stored. */
async function connectedPage(
  status = 'active',
): Promise<{ pageId: string; scope: ConnectionScope }> {
  const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop' });
  const { rows } = await api.pool.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
     VALUES ($1, $2, 'facebook', $3, $4, $5) RETURNING id`,
    [org.orgId, org.brandId, pageId, status, status === 'active' ? null : 'oauth_access_rejected'],
  );
  const scope = { organizationId: org.orgId, brandId: org.brandId, connectionId: rows[0]!.id };
  await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
  return { pageId, scope };
}

/** A comment on the Page in FakeGraph, stored as ingest would store it. */
async function comment(
  p: { pageId: string; scope: ConnectionScope },
  o: { message?: string; postedAt?: Date; state?: 'visible' | 'hidden' } = {},
): Promise<{ id: string; externalId: string }> {
  const postedAt = o.postedAt ?? new Date();
  const c = graph.addComment(p.pageId, {
    message: o.message ?? 'hello',
    createdAtMs: postedAt.getTime(),
  });
  const authorId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const r = await api.deps.comments!.store.upsertFromPlatform(
    p.scope,
    {
      externalId: c.commentId,
      sourceExternalId: c.postId,
      parentExternalId: null,
      author: { externalId: authorId, displayName: `Author ${authorId}`, profileUrl: null },
      body: o.message ?? 'hello',
      postedAt,
      platformState: o.state ?? 'visible',
      permalink: null,
    },
    { ownAccountExternalId: p.pageId, syncedAt: new Date() },
  );
  return { id: r.commentId, externalId: c.commentId };
}

const base = () => `/api/v1/orgs/${org.orgId}/brands/${org.brandId}`;
const act = (commentId: string, body: unknown, cookie = org.owner.cookie) =>
  api.req('POST', `${base()}/comments/${commentId}/actions`, { cookie, body });
const key = () => `rk-${randomUUID()}`;

/** Runs the enqueued execute job for an action the way the worker would. */
async function runExecuteJob(actionId: string, scope: ConnectionScope) {
  const ledger = await api.pool.query<{ id: string; payload: { actionId: string } }>(
    `SELECT id, payload FROM job_ledger WHERE job_type = $1 AND payload->>'actionId' = $2`,
    [EXECUTE_JOB.type, actionId],
  );
  expect(ledger.rows).toHaveLength(1);
  const ctx: JobContext = {
    scope,
    platform: 'facebook',
    jobType: EXECUTE_JOB.type,
    ledgerId: ledger.rows[0]!.id,
    attempt: 1,
    isReplay: false,
    signal: AbortSignal.timeout(30_000),
    log: api.deps.log,
  };
  const job = executeActionJob({
    pool: api.pool,
    runtime: api.deps.connectors!.stack.runtime,
    log: api.deps.log,
  });
  return job.handle(ctx, EXECUTE_JOB.payload.parse(ledger.rows[0]!.payload));
}

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi({ facebook: FACEBOOK }, { fetch: graph.fetch });
  org = await orgWithRoles(api, 'cmt');
  fbUserId = graph.addUser('Dana').userId;
  page = await connectedPage();
});
afterAll(() => api.close());

describe('comments', () => {
  it('lists brand comments newest first with author name and state; another brand sees none', async () => {
    const older = await comment(page, {
      message: 'first',
      postedAt: new Date(Date.now() - 60_000),
    });
    const newer = await comment(page, { message: 'second', state: 'hidden' });
    const tombstone = await api.deps.comments!.store.recordDeleted(
      page.scope,
      { sourceExternalId: `${page.pageId}_999`, externalId: `${page.pageId}_999_1` },
      { syncedAt: new Date(), occurredAt: new Date() },
    );

    const r = await api.req('GET', `${base()}/comments`, { cookie: org.member.cookie });
    expect(r.status).toBe(200);
    const ids = r.body.comments.map((c: { id: string }) => c.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids).not.toContain(tombstone);
    expect(r.body.comments.find((c: { id: string }) => c.id === newer.id)).toMatchObject({
      id: newer.id,
      connectionId: page.scope.connectionId,
      platform: 'facebook',
      body: 'second',
      state: 'hidden',
      authorName: expect.stringMatching(/^Author \d+$/) as string,
      isOwnAccount: false,
    });

    const paged = await api.req(
      'GET',
      `${base()}/comments?limit=1&before=${encodeURIComponent(r.body.comments.find((c: { id: string }) => c.id === newer.id).postedAt)}&connectionId=${page.scope.connectionId}`,
      { cookie: org.owner.cookie },
    );
    expect(paged.status).toBe(200);
    expect(paged.body.comments.map((c: { id: string }) => c.id)).toEqual([older.id]);

    for (const q of ['limit=0', 'limit=101', 'before=yesterday', 'connectionId=x', 'x=1'])
      expect(
        (await api.req('GET', `${base()}/comments?${q}`, { cookie: org.owner.cookie })).status,
        q,
      ).toBe(400);

    const brand = await api.req('POST', `/api/v1/orgs/${org.orgId}/brands`, {
      cookie: org.owner.cookie,
      body: { name: 'Second brand' },
    });
    const other = await api.req(
      'GET',
      `/api/v1/orgs/${org.orgId}/brands/${brand.body.brand.id}/comments`,
      {
        cookie: org.owner.cookie,
      },
    );
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ comments: [] });
    const actions = await api.req(
      'GET',
      `/api/v1/orgs/${org.orgId}/brands/${brand.body.brand.id}/comments/${newer.id}/actions`,
      { cookie: org.owner.cookie },
    );
    expect(actions.status).toBe(404);
  });

  it('POST hide -> 202 pending; worker job run inline -> GET actions shows applied with undo unhide; FakeGraph state hidden', async () => {
    const c = await comment(page);
    const r = await act(c.id, { kind: 'hide', requestKey: key() }, org.member.cookie);
    expect(r.status).toBe(202);
    expect(r.body.action).toMatchObject({
      commentId: c.id,
      kind: 'hide',
      status: 'pending',
      actorType: 'user',
      actorUserId: org.member.userId,
    });
    await runExecuteJob(r.body.action.id, page.scope);
    const list = await api.req('GET', `${base()}/comments/${c.id}/actions`, {
      cookie: org.member.cookie,
    });
    expect(list.status).toBe(200);
    expect(list.body.actions).toEqual([
      expect.objectContaining({ id: r.body.action.id, status: 'applied', undoKind: 'unhide' }),
    ]);
    expect(graph.state(c.externalId)).toBe('hidden');
  });

  it('POST hide on hidden comment -> 200 recorded noop already_hidden', async () => {
    const c = await comment(page, { state: 'hidden' });
    const r = await act(c.id, { kind: 'hide', requestKey: key() });
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({ status: 'noop', outcomeCode: 'already_hidden' });
  });

  it('POST public_reply without text -> 400; with 8001 chars -> 400; with markup -> 202 and stored verbatim', async () => {
    const c = await comment(page);
    expect((await act(c.id, { kind: 'public_reply', requestKey: key() })).status).toBe(400);
    expect(
      (await act(c.id, { kind: 'public_reply', requestKey: key(), text: 'x'.repeat(8001) })).status,
    ).toBe(400);
    expect((await act(c.id, { kind: 'hide', requestKey: key(), text: 'no' })).status).toBe(400);
    expect((await act(c.id, { kind: 'nuke', requestKey: key() })).status).toBe(400);
    expect((await act(c.id, { kind: 'hide', requestKey: 'bad key!' })).status).toBe(400);
    const markup = `<script>alert("x")</script> & <b>thanks</b>`;
    const r = await act(c.id, { kind: 'public_reply', requestKey: key(), text: markup });
    expect(r.status).toBe(202);
    expect(r.body.action.replyText).toBe(markup);
    const stored = await api.pool.query('SELECT reply_text FROM moderation_action WHERE id = $1', [
      r.body.action.id,
    ]);
    expect(stored.rows[0].reply_text).toBe(markup);
    expect(api.logLines.join('\n')).not.toContain('thanks');
  });

  it('POST private_reply twice -> second is 200 not_eligible private_reply_already_sent', async () => {
    const c = await comment(page);
    const first = await act(c.id, { kind: 'private_reply', requestKey: key(), text: 'DM' });
    expect(first.status).toBe(202);
    const second = await act(c.id, { kind: 'private_reply', requestKey: key(), text: 'DM' });
    expect(second.status).toBe(200);
    expect(second.body.action).toMatchObject({
      status: 'not_eligible',
      outcomeCode: 'private_reply_already_sent',
    });
  });

  it('POST on a connection needing reconnect -> 409 connection_needs_reconnect', async () => {
    const stale = await connectedPage();
    const c = await comment(stale);
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1`,
      [stale.scope.connectionId],
    );
    const r = await act(c.id, { kind: 'hide', requestKey: key() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('connection_needs_reconnect');
    await api.pool.query(
      `UPDATE connection SET status = 'paused', status_reason = NULL WHERE id = $1`,
      [stale.scope.connectionId],
    );
    const paused = await act(c.id, { kind: 'hide', requestKey: key() });
    expect(paused.status).toBe(409);
    expect(paused.body.error.code).toBe('connection_inactive');
  });

  it('same requestKey twice -> same action id, one row', async () => {
    const c = await comment(page);
    const k = key();
    const a = await act(c.id, { kind: 'delete', requestKey: k });
    const b = await act(c.id, { kind: 'delete', requestKey: k });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.action.id).toBe(a.body.action.id);
    const rows = await api.pool.query('SELECT id FROM moderation_action WHERE request_key = $1', [
      k,
    ]);
    expect(rows.rows).toHaveLength(1);
    const conflict = await act(c.id, { kind: 'hide', requestKey: k });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('request_key_conflict');
  });

  it('unknown comments are 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await act(missing, { kind: 'hide', requestKey: key() })).status).toBe(404);
    expect((await act('nope', { kind: 'hide', requestKey: key() })).status).toBe(404);
    const r = await api.req('GET', `${base()}/comments/${missing}/actions`, {
      cookie: org.owner.cookie,
    });
    expect(r.status).toBe(404);
  });
});
