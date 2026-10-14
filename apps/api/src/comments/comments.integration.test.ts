// Comment listing and moderation actions over the API. Comments are stored the
// way the ingest job stores them; the execute job is run inline against
// FakeGraph (the worker runs it in production).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { ACTION_KINDS, EXECUTE_JOB, executeActionJob } from '@feedbouncer/comments';
import { systemClock } from '@feedbouncer/connectors';
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
  o: {
    message?: string;
    postedAt?: Date;
    state?: 'visible' | 'hidden';
    parent?: { externalId: string; postId: string };
  } = {},
): Promise<{ id: string; externalId: string; postId: string }> {
  const postedAt = o.postedAt ?? new Date();
  const c = graph.addComment(p.pageId, {
    message: o.message ?? 'hello',
    createdAtMs: postedAt.getTime(),
    ...(o.parent && { parentId: o.parent.externalId, postId: o.parent.postId }),
  });
  const authorId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const r = await api.deps.comments!.store.upsertFromPlatform(
    p.scope,
    {
      externalId: c.commentId,
      sourceExternalId: c.postId,
      parentExternalId: o.parent?.externalId ?? null,
      author: { externalId: authorId, displayName: `Author ${authorId}`, profileUrl: null },
      body: o.message ?? 'hello',
      postedAt,
      platformState: o.state ?? 'visible',
      permalink: null,
    },
    { ownAccountExternalId: p.pageId, syncedAt: new Date() },
  );
  return { id: r.commentId, externalId: c.commentId, postId: c.postId };
}

const base = () => `/api/v1/orgs/${org.orgId}/brands/${org.brandId}`;
const act = (commentId: string, body: unknown, cookie = org.owner.cookie) =>
  api.req('POST', `${base()}/comments/${commentId}/actions`, { cookie, body });
const key = () => `rk-${randomUUID()}`;

/** Runs the enqueued execute job for an action the way the worker would. */
async function runExecuteJob(
  actionId: string,
  scope: ConnectionScope,
  platform: 'facebook' | 'instagram' = 'facebook',
) {
  const ledger = await api.pool.query<{ id: string; payload: { actionId: string } }>(
    `SELECT id, payload FROM job_ledger WHERE job_type = $1 AND payload->>'actionId' = $2`,
    [EXECUTE_JOB.type, actionId],
  );
  expect(ledger.rows).toHaveLength(1);
  const ctx: JobContext = {
    scope,
    platform,
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
    producer: api.deps.producer!,
    clock: systemClock,
  });
  return job.handle(ctx, EXECUTE_JOB.payload.parse(ledger.rows[0]!.payload));
}

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi(
    { facebook: FACEBOOK, instagram: { meta: FACEBOOK } },
    { fetch: graph.fetch },
  );
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
      hasAuthor: true,
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

// ---- Instagram: platform, media and server-computed availability ----

const DAY = 86_400_000;
const PERMALINK = 'https://www.instagram.com/p/Cabc123/';

/** An active Instagram connection for a FakeGraph account linked to a Page, with its token stored. */
async function connectedInstagram(
  target: OrgFixture = org,
): Promise<{ igUserId: string; scope: ConnectionScope }> {
  const { pageId, pageToken } = graph.addPage(fbUserId, { name: 'Shop' });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' });
  const { scope } = await api.seedConnection(target, {
    platform: 'instagram',
    externalAccountId: igUserId,
  });
  await api.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(pageToken), null);
  return { igUserId, scope };
}

/** A comment on the account in FakeGraph, stored as the instagram ingest would store it. */
async function igComment(
  a: { igUserId: string; scope: ConnectionScope },
  o: {
    text?: string;
    postedAt?: Date;
    state?: 'visible' | 'hidden';
    parent?: { externalId: string };
    own?: boolean;
  } = {},
): Promise<{ id: string; externalId: string; mediaId: string }> {
  const postedAt = o.postedAt ?? new Date();
  const authorId = o.own ? a.igUserId : String(17_800_000_000 + Math.floor(Math.random() * 1e6));
  const c = graph.addIgComment(a.igUserId, {
    text: o.text ?? 'hello',
    createdAtMs: postedAt.getTime(),
    authorId,
    ...(o.parent && { parentId: o.parent.externalId }),
  });
  const r = await api.deps.comments!.store.upsertFromPlatform(
    a.scope,
    {
      externalId: c.commentId,
      sourceExternalId: c.mediaId,
      parentExternalId: o.parent?.externalId ?? null,
      author: { externalId: authorId, displayName: `ig_${authorId}`, profileUrl: null },
      body: o.text ?? 'hello',
      postedAt,
      platformState: o.state ?? 'visible',
      permalink: PERMALINK,
    },
    { ownAccountExternalId: a.igUserId, syncedAt: new Date() },
  );
  return { id: r.commentId, externalId: c.commentId, mediaId: c.mediaId };
}

async function setConnectionStatus(connectionId: string, status: 'reconnect_required' | 'paused') {
  await api.pool.query(`UPDATE connection SET status = $2, status_reason = $3 WHERE id = $1`, [
    connectionId,
    status,
    status === 'reconnect_required' ? 'oauth_access_rejected' : null,
  ]);
}

interface ListedComment {
  id: string;
  platform: string;
  mediaExternalId: string;
  permalink: string | null;
  availability: Record<string, { available: boolean; reason?: string }>;
  replyLimits: { public_reply: number; private_reply: number };
  body: string;
}

async function listed(
  from: OrgFixture = org,
  cookie = from.owner.cookie,
): Promise<Map<string, ListedComment>> {
  const r = await api.req(
    'GET',
    `/api/v1/orgs/${from.orgId}/brands/${from.brandId}/comments?limit=100`,
    { cookie },
  );
  expect(r.status).toBe(200);
  return new Map((r.body.comments as ListedComment[]).map((c) => [c.id, c]));
}

describe('comments: instagram platform, media and availability', () => {
  it('instagram comment lists platform, media id, permalink and availability (ban unsupported, nested private reply unavailable)', async () => {
    const ig = await connectedInstagram();
    const top = await igComment(ig);
    const nested = await igComment(ig, { parent: top });
    const all = await listed();

    const t = all.get(top.id)!;
    expect(t).toMatchObject({
      platform: 'instagram',
      mediaExternalId: top.mediaId,
      permalink: PERMALINK,
      replyLimits: { public_reply: 2200, private_reply: 1000 },
    });
    expect(t.availability).toEqual({
      hide: { available: true },
      unhide: { available: false, reason: 'already_visible' },
      delete: { available: true },
      ban_author: { available: false, reason: 'unsupported' },
      unban_author: { available: false, reason: 'unsupported' },
      public_reply: { available: true },
      private_reply: { available: true },
    });
    expect(all.get(nested.id)!.availability.private_reply).toEqual({
      available: false,
      reason: 'private_reply_nested_comment',
    });
    expect(all.get(nested.id)!.availability.public_reply).toEqual({ available: true });
  });

  it('availability for a hidden instagram comment says reply_to_hidden_comment', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig, { state: 'hidden' });
    const a = (await listed()).get(c.id)!.availability;
    expect(a.public_reply).toEqual({ available: false, reason: 'reply_to_hidden_comment' });
    expect(a.hide).toEqual({ available: false, reason: 'already_hidden' });
    expect(a.unhide).toEqual({ available: true });
  });

  it('a visible nested comment under a hidden parent: instagram public_reply unavailable (the reply goes on the parent), facebook unchanged', async () => {
    const ig = await connectedInstagram();
    const igTop = await igComment(ig, { state: 'hidden' });
    const igNested = await igComment(ig, { parent: igTop });
    const fbPage = await connectedPage();
    const fbTop = await comment(fbPage, { state: 'hidden' });
    const fbNested = await comment(fbPage, { parent: fbTop });
    const all = await listed();
    expect(all.get(igNested.id)!.availability.public_reply).toEqual({
      available: false,
      reason: 'reply_to_hidden_comment',
    });
    expect(all.get(fbNested.id)!.availability.public_reply).toEqual({ available: true });

    const r = await act(igNested.id, { kind: 'public_reply', requestKey: key(), text: 'hi' });
    expect(r.status).toBe(200);
    expect(r.body.action).toMatchObject({
      status: 'not_eligible',
      outcomeCode: 'reply_to_hidden_comment',
    });
    const f = await act(fbNested.id, { kind: 'public_reply', requestKey: key(), text: 'hi' });
    expect(f.status).toBe(202);
  });

  it('a connection that needs reconnecting or is paused makes every action unavailable with that reason', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig);
    await setConnectionStatus(ig.scope.connectionId, 'reconnect_required');
    expect(Object.values((await listed()).get(c.id)!.availability)).toEqual(
      ACTION_KINDS.map(() => ({ available: false, reason: 'connection_needs_reconnect' })),
    );
    await setConnectionStatus(ig.scope.connectionId, 'paused');
    expect(Object.values((await listed()).get(c.id)!.availability)).toEqual(
      ACTION_KINDS.map(() => ({ available: false, reason: 'connection_inactive' })),
    );
  });

  it('availability turns private_reply off after one is sent (private_reply_already_sent)', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig);
    expect((await listed()).get(c.id)!.availability.private_reply).toEqual({ available: true });
    const r = await act(c.id, { kind: 'private_reply', requestKey: key(), text: 'DM' });
    expect(r.status).toBe(202);
    expect((await listed()).get(c.id)!.availability.private_reply).toEqual({
      available: false,
      reason: 'private_reply_already_sent',
    });
  });

  it('an action marked available by the list is accepted by POST actions, and one marked unavailable is recorded with that same reason', async () => {
    const ig = await connectedInstagram();
    const fbPage = await connectedPage();
    const top = await igComment(ig);
    const hiddenTop = await igComment(ig, { state: 'hidden' });
    const fbHiddenTop = await comment(fbPage, { state: 'hidden' });
    const states = [
      await igComment(ig),
      await igComment(ig, { state: 'hidden' }),
      await igComment(ig, { parent: top }),
      await igComment(ig, { parent: hiddenTop }),
      await igComment(ig, { parent: top, state: 'hidden' }),
      await comment(fbPage, { parent: fbHiddenTop }),
      await igComment(ig, { own: true }),
      await igComment(ig, { postedAt: new Date(Date.now() - 8 * DAY) }),
      await comment(fbPage),
      await comment(fbPage, { state: 'hidden' }),
      await comment(fbPage, { postedAt: new Date(Date.now() - 8 * DAY) }),
    ];
    const withPrivateReply = await igComment(ig);
    expect(
      (await act(withPrivateReply.id, { kind: 'private_reply', requestKey: key(), text: 'x' }))
        .status,
    ).toBe(202);
    // Connections that cannot act: every action is refused with the connection's reason.
    const igStale = await connectedInstagram();
    const fbPaused = await connectedPage();
    const onInactive = [await igComment(igStale), await comment(fbPaused)];
    await setConnectionStatus(igStale.scope.connectionId, 'reconnect_required');
    await setConnectionStatus(fbPaused.scope.connectionId, 'paused');
    const subjects = [...states, withPrivateReply, ...onInactive];

    const before = await listed();
    const seen = { available: 0, noop: 0, notEligible: 0, unsupported: 0, connection: 0 };
    for (const s of subjects) {
      for (const kind of ACTION_KINDS) {
        const avail = before.get(s.id)!.availability[kind]!;
        const body = {
          kind,
          requestKey: key(),
          ...(kind.endsWith('_reply') && { text: 'thanks' }),
        };
        const r = await act(s.id, body);
        const label = `${s.id} ${kind}`;
        if (avail.available) {
          expect(r.status, label).toBe(202);
          expect(r.body.action.status, label).toBe('pending');
          seen.available++;
        } else if (
          avail.reason === 'connection_needs_reconnect' ||
          avail.reason === 'connection_inactive'
        ) {
          expect(r.status, label).toBe(409);
          expect(r.body.error.code, label).toBe(avail.reason);
          seen.connection++;
        } else if (avail.reason === 'unsupported') {
          expect(r.status, label).toBe(422);
          expect(r.body.error.code, label).toBe('unsupported_action');
          seen.unsupported++;
        } else {
          expect(r.status, label).toBe(200);
          expect(['noop', 'not_eligible'], label).toContain(r.body.action.status);
          expect(r.body.action.outcomeCode, label).toBe(avail.reason);
          seen[r.body.action.status === 'noop' ? 'noop' : 'notEligible']++;
        }
      }
    }
    // The matrix exercised every branch, so agreement is not vacuous.
    expect(seen.available).toBeGreaterThan(0);
    expect(seen.noop).toBeGreaterThan(0);
    expect(seen.notEligible).toBeGreaterThan(0);
    expect(seen.unsupported).toBeGreaterThan(0);
    expect(seen.connection).toBe(onInactive.length * ACTION_KINDS.length);
  });

  it('POST a 2201-code-point instagram reply -> 422 text_too_long with max 2200, nothing recorded', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig);
    const r = await act(c.id, { kind: 'public_reply', requestKey: key(), text: '😀'.repeat(2201) });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'text_too_long', max: 2200 });
    const priv = await act(c.id, {
      kind: 'private_reply',
      requestKey: key(),
      text: 'x'.repeat(1001),
    });
    expect(priv.status).toBe(422);
    expect(priv.body.error).toMatchObject({ code: 'text_too_long', max: 1000 });
    const rows = await api.pool.query('SELECT id FROM moderation_action WHERE comment_id = $1', [
      c.id,
    ]);
    expect(rows.rows).toHaveLength(0);
    // The limit itself is accepted.
    const ok = await act(c.id, {
      kind: 'public_reply',
      requestKey: key(),
      text: '😀'.repeat(2200),
    });
    expect(ok.status).toBe(202);
  });

  it('every action records actor user, comment, time, and outcome; GET actions shows pending -> applied', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig);
    const before = Date.now();
    const r = await act(c.id, { kind: 'hide', requestKey: key() }, org.member.cookie);
    expect(r.status).toBe(202);
    const pending = await api.req('GET', `${base()}/comments/${c.id}/actions`, {
      cookie: org.member.cookie,
    });
    expect(pending.body.actions).toEqual([
      expect.objectContaining({
        id: r.body.action.id,
        commentId: c.id,
        kind: 'hide',
        status: 'pending',
        actorType: 'user',
        actorUserId: org.member.userId,
        outcomeCode: null,
        completedAt: null,
      }),
    ]);
    expect(Date.parse(pending.body.actions[0].createdAt)).toBeGreaterThanOrEqual(before - 1000);

    await runExecuteJob(r.body.action.id, ig.scope, 'instagram');
    const applied = await api.req('GET', `${base()}/comments/${c.id}/actions`, {
      cookie: org.member.cookie,
    });
    expect(applied.body.actions).toEqual([
      expect.objectContaining({
        id: r.body.action.id,
        status: 'applied',
        actorUserId: org.member.userId,
        undoKind: 'unhide',
        completedAt: expect.any(String) as string,
      }),
    ]);
    expect(graph.igState(c.externalId)).toBe('hidden');
    expect((await listed()).get(c.id)!.availability.hide).toEqual({
      available: false,
      reason: 'already_hidden',
    });
  });

  it('brand B moderator gets 404 on brand A instagram comment actions and never sees A comments in its list', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig, { text: 'secret of brand A' });
    const other = await orgWithRoles(api, 'cmtb');
    await connectedInstagram(other).then((b) => igComment(b, { text: 'brand B own' }));
    const otherBase = `/api/v1/orgs/${other.orgId}/brands/${other.brandId}`;

    const list = await api.req('GET', `${otherBase}/comments?limit=100`, {
      cookie: other.member.cookie,
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('secret of brand A');
    expect(list.body.comments.map((x: { id: string }) => x.id)).not.toContain(c.id);

    const post = await api.req('POST', `${otherBase}/comments/${c.id}/actions`, {
      cookie: other.member.cookie,
      body: { kind: 'hide', requestKey: key() },
    });
    expect(post.status).toBe(404);
    const get = await api.req('GET', `${otherBase}/comments/${c.id}/actions`, {
      cookie: other.member.cookie,
    });
    expect(get.status).toBe(404);
    // Addressing A's brand with B's session is refused outright.
    const cross = await api.req('POST', `${base()}/comments/${c.id}/actions`, {
      cookie: other.member.cookie,
      body: { kind: 'hide', requestKey: key() },
    });
    expect([403, 404]).toContain(cross.status);
    const rows = await api.pool.query('SELECT id FROM moderation_action WHERE comment_id = $1', [
      c.id,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it('a comment body with markup, RTL, emoji and 10k chars is returned verbatim as a JSON string', async () => {
    const ig = await connectedInstagram();
    const text = `<img src=x onerror=alert(1)> שלום עולם مرحبا 👩‍👩‍👧‍👦 \u202e&amp;${'א'.repeat(10_000)}`;
    const c = await igComment(ig, { text });
    const r = await api.req('GET', `${base()}/comments?limit=100`, { cookie: org.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const got = (r.body.comments as ListedComment[]).find((x) => x.id === c.id)!;
    expect(typeof got.body).toBe('string');
    expect(got.body).toBe(text);
  });

  it('with the platform connector not registered every action is unsupported, as POST refuses it, and limits are the defaults', async () => {
    const ig = await connectedInstagram();
    const c = await igComment(ig);
    const registry = api.deps.connectors!.registry;
    const original = registry.get.bind(registry);
    const spy = vi
      .spyOn(registry, 'get')
      .mockImplementation((p) => (p === 'instagram' ? undefined : original(p)));
    try {
      const got = (await listed()).get(c.id)!;
      for (const kind of ACTION_KINDS)
        expect(got.availability[kind], kind).toEqual({
          available: false,
          reason: 'unsupported',
        });
      expect(got.replyLimits).toEqual({ public_reply: 8000, private_reply: 8000 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ad origin', () => {
  it('origin filter and ad fields', async () => {
    const organic = await comment(page, { message: 'organic one' });
    const onAd = await comment(page, { message: 'on an ad' });
    const ads = await api.pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'meta_ads', $3) RETURNING id`,
      [org.orgId, org.brandId, `act-${randomUUID().slice(0, 8)}`],
    );
    const ad = await api.pool.query<{ id: string }>(
      `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id,
                            ad_account_external_id, effective_status, active,
                            facebook_source_external_id, facebook_resolution,
                            instagram_resolution, last_discovered_at)
       VALUES ($1, $2, $3, '555001', '1001', 'ACTIVE', true, $4, 'linked', 'not_instagram', now())
       RETURNING id`,
      [org.orgId, org.brandId, ads.rows[0]!.id, onAd.postId],
    );
    await api.pool.query(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       SELECT c.organization_id, c.brand_id, $2, c.source_id, 'facebook' FROM comment c WHERE c.id = $1`,
      [onAd.id, ad.rows[0]!.id],
    );
    const get = (q: string) =>
      api.req('GET', `${base()}/comments?limit=100${q}`, { cookie: org.owner.cookie });
    const adOnly = await get('&origin=ad');
    expect(adOnly.status).toBe(200);
    const adIds = adOnly.body.comments.map((c: { id: string }) => c.id);
    expect(adIds).toContain(onAd.id);
    expect(adIds).not.toContain(organic.id);
    expect(adOnly.body.comments.find((c: { id: string }) => c.id === onAd.id)).toMatchObject({
      origin: 'ad',
      ads: [{ adId: '555001', adAccountId: '1001' }],
    });
    const organicOnly = await get('&origin=organic');
    const organicIds = organicOnly.body.comments.map((c: { id: string }) => c.id);
    expect(organicIds).toContain(organic.id);
    expect(organicIds).not.toContain(onAd.id);
    expect((await get('&origin=x')).status).toBe(400);
  });
});
