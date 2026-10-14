// Runs the execute handler directly over the Pg stack and the real connector
// runtime, with FakeGraph as the platform. Actions are requested through
// ModerationActions with a stub producer; the job framework is covered by
// @feedbouncer/jobs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  ConnectorError,
  ConnectorRegistry,
  ConnectorRuntime,
  MemoryRefreshLock,
  PgConnectionDirectory,
  PgCredentialVault,
  TokenManager,
  createSafeHttp,
  memoryBudget,
  type Clock,
  type Connector,
} from '@feedbouncer/connectors';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import {
  classifyFailure,
  type EnqueueRequest,
  type EnqueueResult,
  type JobContext,
} from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import type { ActionKind } from '../action-kinds.js';
import { ModerationActions } from '../actions.js';
import { ingestCommentJob } from './ingest.js';
import { executeActionJob } from './execute.js';
import { EXECUTE_JOB, INGEST_JOB } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-execute-test', 'error', () => {});

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let n = 0;
// Real time: action created_at comes from the database clock.
let nowMs = Date.now();
const clock: Clock = { now: () => nowMs };

let t: Tenant;
let scope: ConnectionScope;
let store: PgCommentStore;
let graph: FakeGraph;
let pageId: string;
let pageToken: string;
let runtime: ConnectorRuntime;
let actions: ModerationActions;
let job: ReturnType<typeof executeActionJob>;
let ingest: ReturnType<typeof ingestCommentJob>;
/** The execute job's producer (resync ingests). */
let creds: CredentialStore;
let resync: ReturnType<typeof vi.fn<(r: EnqueueRequest) => Promise<EnqueueResult>>>;
const lines: string[] = [];
/** The one comment seeded by beforeEach. */
let seeded: { postId: string; commentId: string; id: string };

const jobCtx = (attempt = 1, jobType: string = EXECUTE_JOB.type): JobContext => ({
  scope,
  platform: 'facebook',
  jobType,
  ledgerId: randomUUID(),
  attempt,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log,
});

async function ingestComment(c: { postId: string; commentId: string }): Promise<string> {
  const r = await ingest.handle(
    jobCtx(1, INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      sourceExternalId: c.postId,
      commentExternalId: c.commentId,
      event: 'created',
      platformEventSec: Math.floor(nowMs / 1000),
      changeId: '0123456789abcdef',
    }),
  );
  return r.commentId as string;
}

async function requestAction(commentId: string, kind: ActionKind, text?: string): Promise<string> {
  const r = await actions.request({
    scope: t,
    commentId,
    kind,
    actor: { type: 'user', userId: t.userId },
    requestKey: `rk-${randomUUID()}`,
    ...(text !== undefined ? { text } : {}),
  });
  if (r.status !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(r)}`);
  return r.action.id;
}

const run = (actionId: string, attempt = 1) =>
  job.handle(jobCtx(attempt), EXECUTE_JOB.payload.parse({ actionId }));

const actionRow = async (id: string) =>
  (
    await pool.query(
      `SELECT status, outcome_code, platform_ref, undo_kind, completed_at
         FROM moderation_action WHERE id = $1`,
      [id],
    )
  ).rows[0];

const auditFor = async (actionId: string) =>
  (
    await pool.query(
      `SELECT actor_type, actor_user_id, action, subject_type, subject_id, brand_id, details
         FROM audit_event WHERE organization_id = $1 AND details->>'actionId' = $2`,
      [t.organizationId, actionId],
    )
  ).rows;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-execute-test',
    onIdleError: () => {},
  });
  store = new PgCommentStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  nowMs = Date.now();
  t = await seedTenant(ctx.c, `exe${++n}`);
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  pageToken = page.pageToken;
  // Each case gets a fresh FakeGraph, which reuses Page ids: retire earlier tenants' rows
  // (one live connection per Page).
  await ctx.c.query(
    "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE external_account_id = $1",
    [page.pageId],
  );
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    pageId,
    t.connectionId,
  ]);
  creds = new CredentialStore(pool, testKeyring(['k1']));
  await creds.put(scope, 'access_token', new Secret(pageToken), null);

  const meta = {
    appId: '111',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  };
  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(meta, { clock }));
  registry.register(createInstagramConnector({ meta }, { clock }));
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: graph.fetch });
  const directory = new PgConnectionDirectory(pool);
  const vault = new PgCredentialVault(creds, pool, log);
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log,
    oauthContext: (c) => ({
      http: http(c),
      signal: AbortSignal.timeout(15_000),
      redirectUri: 'https://app.test/api/v1/oauth/facebook/callback',
    }),
  });
  runtime = new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget: memoryBudget(),
    clock,
    log,
    http,
  });
  actions = new ModerationActions({
    pool,
    store,
    producer: {
      enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
    },
    capabilities: (p) => registry.get(p)?.capabilities,
    clock,
    log,
  });
  ingest = ingestCommentJob({ runtime, directory, store, clock });
  resync = vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' }));
  lines.length = 0;
  job = executeActionJob({
    pool,
    runtime,
    log: createLogger('comments-execute-test', 'info', (l) => lines.push(l)),
    producer: { enqueue: resync },
    clock,
  });

  const c = graph.addComment(pageId, { message: 'spam here', createdAtMs: nowMs - 60_000 });
  seeded = { ...c, id: await ingestComment(c) };
});

describe('moderation execute job', () => {
  it('hide applies on Facebook, records applied with undo unhide, updates comment state, writes audit', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    expect(await run(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: 'unhide' });
    expect(resync).not.toHaveBeenCalled();
    expect(graph.state(seeded.commentId)).toBe('hidden');
    expect(await actionRow(actionId)).toMatchObject({
      status: 'applied',
      outcome_code: null,
      undo_kind: 'unhide',
      completed_at: expect.any(Date),
    });
    expect((await store.load(t, seeded.id))?.platformState).toBe('hidden');
    expect(await auditFor(actionId)).toEqual([
      {
        actor_type: 'user',
        actor_user_id: t.userId,
        action: 'comment.moderated',
        subject_type: 'comment',
        subject_id: seeded.id,
        brand_id: t.brandId,
        details: { actionId, kind: 'hide', status: 'applied', outcomeCode: null },
      },
    ]);

    const unhide = await requestAction(seeded.id, 'unhide');
    expect(await run(unhide)).toEqual({ status: 'applied', outcomeCode: null, undo: 'hide' });
    expect((await store.load(t, seeded.id))?.platformState).toBe('visible');
  });

  it('delete of a comment already gone on Facebook -> noop comment_gone, comment marked deleted', async () => {
    const actionId = await requestAction(seeded.id, 'delete');
    graph.removeComment(seeded.commentId);
    nowMs += 3_600_000;
    expect(await run(actionId)).toEqual({
      status: 'noop',
      outcomeCode: 'comment_gone',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_gone',
    });
    expect((await store.load(t, seeded.id))?.platformState).toBe('deleted');
    expect(await auditFor(actionId)).toHaveLength(1);
    // The platform disagreed with what we stored: the comment is re-read.
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0]![0]).toMatchObject({
      scope,
      platform: 'facebook',
      type: INGEST_JOB.type,
      payload: {
        sourceExternalId: seeded.postId,
        commentExternalId: seeded.commentId,
        platformEventSec: Math.floor(nowMs / 1000),
      },
    });
  });

  it('delete applies and marks the comment deleted (not reversible)', async () => {
    const actionId = await requestAction(seeded.id, 'delete');
    expect(await run(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    expect(graph.state(seeded.commentId)).toBe('deleted');
    expect((await store.load(t, seeded.id))?.platformState).toBe('deleted');
  });

  it('ban sends the stored author id and records undo unban_author', async () => {
    const author = (await store.load(t, seeded.id))?.authorExternalId;
    const actionId = await requestAction(seeded.id, 'ban_author');
    expect(await run(actionId)).toEqual({
      status: 'applied',
      outcomeCode: null,
      undo: 'unban_author',
    });
    expect(graph.blocked(pageId)).toEqual([author]);
    expect(await actionRow(actionId)).toMatchObject({ platform_ref: author });
  });

  it('ban then unban by author id still work after the comment is deleted', async () => {
    const author = (await store.load(t, seeded.id))?.authorExternalId;
    expect(await run(await requestAction(seeded.id, 'ban_author'))).toMatchObject({
      status: 'applied',
    });
    expect(await run(await requestAction(seeded.id, 'delete'))).toMatchObject({
      status: 'applied',
    });
    expect(graph.blocked(pageId)).toEqual([author]);
    expect(await run(await requestAction(seeded.id, 'unban_author'))).toEqual({
      status: 'applied',
      outcomeCode: null,
      undo: 'ban_author',
    });
    expect(graph.blocked(pageId)).toEqual([]);
    expect((await store.load(t, seeded.id))?.platformState).toBe('deleted');
  });

  it('a ban the platform refuses for the author is not_eligible with that code', async () => {
    const actionId = await requestAction(seeded.id, 'ban_author');
    graph.failNext(3801);
    expect(await run(actionId)).toEqual({
      status: 'not_eligible',
      outcomeCode: 'ban_limit_reached',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'not_eligible',
      outcome_code: 'ban_limit_reached',
    });
  });

  it('public reply to a nested reply posts on the parent thread', async () => {
    const nested = graph.addComment(pageId, {
      postId: seeded.postId,
      parentId: seeded.commentId,
      message: 'a reply',
    });
    const nestedId = await ingestComment(nested);
    expect((await store.load(t, nestedId))?.parentExternalId).toBe(seeded.commentId);
    const actionId = await requestAction(nestedId, 'public_reply', 'thanks for asking');
    const r = await run(actionId);
    expect(r).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    const onParent = graph.replies(seeded.commentId).filter((x) => x.fromId === pageId);
    expect(onParent).toEqual([
      { id: expect.any(String), fromId: pageId, message: 'thanks for asking' },
    ]);
    expect(graph.replies(nested.commentId)).toEqual([]);
    expect(await actionRow(actionId)).toMatchObject({
      status: 'applied',
      platform_ref: onParent[0]!.id,
    });
  });

  it('public reply to a top-level comment posts on that comment', async () => {
    const actionId = await requestAction(seeded.id, 'public_reply', 'hello there');
    await run(actionId);
    expect(graph.replies(seeded.commentId)).toMatchObject([
      { fromId: pageId, message: 'hello there' },
    ]);
  });

  it('attempt 2 finds the public reply posted by attempt 1 and does not post again', async () => {
    const actionId = await requestAction(seeded.id, 'public_reply', 'we are on it');
    // Attempt 1 posted the reply, then crashed before recording it.
    const client = await runtime.connect(scope);
    const first = await client.respond({
      kind: 'public_reply',
      target: { sourceExternalId: seeded.postId, externalId: seeded.commentId },
      text: 'we are on it',
    });
    if (first.status !== 'sent') throw new Error('expected sent');
    nowMs += 5_000;
    expect(await run(actionId, 2)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    const replies = graph.replies(seeded.commentId);
    expect(replies).toHaveLength(1);
    expect(await actionRow(actionId)).toMatchObject({
      status: 'applied',
      platform_ref: replies[0]!.id,
    });
    expect(replies[0]!.id).toBe(first.platformRef);
  });

  it('attempt 2 posts when the earlier attempt left no matching reply', async () => {
    const actionId = await requestAction(seeded.id, 'public_reply', 'second try');
    // A different reply by the Page and an identical text by someone else do not count.
    const client = await runtime.connect(scope);
    await client.respond({
      kind: 'public_reply',
      target: { sourceExternalId: seeded.postId, externalId: seeded.commentId },
      text: 'something else',
    });
    graph.addComment(pageId, {
      postId: seeded.postId,
      parentId: seeded.commentId,
      message: 'second try',
    });
    expect(await run(actionId, 2)).toMatchObject({ status: 'applied' });
    const ours = graph
      .replies(seeded.commentId)
      .filter((r) => r.fromId === pageId && r.message === 'second try');
    expect(ours).toHaveLength(1);
  });

  it('private reply attempt 2 seeing already_sent -> applied', async () => {
    const actionId = await requestAction(seeded.id, 'private_reply', 'check your inbox');
    const client = await runtime.connect(scope);
    await client.respond({
      kind: 'private_reply',
      target: { sourceExternalId: seeded.postId, externalId: seeded.commentId },
      text: 'check your inbox',
    });
    expect(await run(actionId, 2)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    expect(graph.privateReplies(seeded.commentId)).toEqual(['check your inbox']);
    expect(await actionRow(actionId)).toMatchObject({ status: 'applied', platform_ref: null });
  });

  it('private reply already sent on attempt 1 -> not_eligible private_reply_already_sent', async () => {
    const actionId = await requestAction(seeded.id, 'private_reply', 'hello');
    const client = await runtime.connect(scope);
    await client.respond({
      kind: 'private_reply',
      target: { sourceExternalId: seeded.postId, externalId: seeded.commentId },
      text: 'sent elsewhere',
    });
    expect(await run(actionId, 1)).toEqual({
      status: 'not_eligible',
      outcomeCode: 'private_reply_already_sent',
      undo: null,
    });
  });

  it('private reply sends a message and stores its id', async () => {
    const actionId = await requestAction(seeded.id, 'private_reply', 'dm text');
    expect(await run(actionId)).toMatchObject({ status: 'applied' });
    expect(graph.privateReplies(seeded.commentId)).toEqual(['dm text']);
    expect((await actionRow(actionId)).platform_ref).toMatch(/^m_/);
  });

  it('throttled -> throws rate_limited and the row stays pending', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    graph.throttleNext();
    const err = await run(actionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect(classifyFailure(err).kind).toBe('rate_limited');
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending', completed_at: null });
    expect(await auditFor(actionId)).toEqual([]);
    expect(graph.state(seeded.commentId)).toBe('visible');
  });

  it('revoked token -> throws auth_expired, row stays pending, connection reconnect_required', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    graph.revokePageToken(pageId);
    const err = await run(actionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'auth_expired', reauthorize: true });
    expect(classifyFailure(err).kind).toBe('needs_reconnection');
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending' });
    const conn = await pool.query('SELECT status FROM connection WHERE id = $1', [t.connectionId]);
    expect(conn.rows[0].status).toBe('reconnect_required');
  });

  it('a disconnected connection -> failed connection_revoked (cannot be retried)', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    await ctx.c.query(
      "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE id = $1",
      [t.connectionId],
    );
    expect(await run(actionId)).toEqual({
      status: 'failed',
      outcomeCode: 'connection_revoked',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'failed',
      outcome_code: 'connection_revoked',
    });
  });

  it('a transient failure is retried, and recorded as failed on the last attempt', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    graph.failNext(2);
    const err = await run(actionId, 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'transient' });
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending' });

    graph.failNext(2);
    const last = await run(actionId, EXECUTE_JOB.policy.maxAttempts).catch((e: unknown) => e);
    expect(last).toBeInstanceOf(ConnectorError);
    expect(last).toMatchObject({ kind: 'transient' });
    const row = await actionRow(actionId);
    expect(row).toMatchObject({ status: 'failed', outcome_code: (last as ConnectorError).code });
    expect(await auditFor(actionId)).toHaveLength(1);
  });

  it('already-completed action is a no-op on redelivery', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    await run(actionId);
    const calls = graph.calls().length;
    expect(await run(actionId, 2)).toEqual({ status: 'applied' });
    expect(graph.calls()).toHaveLength(calls);
    expect(await auditFor(actionId)).toHaveLength(1);
  });

  it('an action from another tenant is not found', async () => {
    const actionId = await requestAction(seeded.id, 'hide');
    const err = await job
      .handle(
        { ...jobCtx(), scope: { ...scope, brandId: randomUUID() } },
        EXECUTE_JOB.payload.parse({ actionId }),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'non_retryable', code: 'action_not_found' });
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending' });
  });

  it('audit details never contain reply text', async () => {
    const text = 'unique reply text 7f3a';
    const actionId = await requestAction(seeded.id, 'public_reply', text);
    const result = await run(actionId);
    const audit = await auditFor(actionId);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({
      actionId,
      kind: 'public_reply',
      status: 'applied',
      outcomeCode: null,
    });
    expect(JSON.stringify(audit)).not.toContain(text);
    expect(JSON.stringify(result)).not.toContain(text);
    expect(JSON.stringify(result)).not.toContain(pageToken);
  });
});

describe('moderation execute job on instagram', () => {
  let igUserId: string;
  let igScope: ConnectionScope;
  /** A top-level comment by someone else, stored through the ingest job. */
  let ig: { mediaId: string; commentId: string; id: string };

  const igCtx = (attempt = 1, jobType: string = EXECUTE_JOB.type): JobContext => ({
    ...jobCtx(attempt, jobType),
    scope: igScope,
    platform: 'instagram',
  });
  const runIg = (actionId: string, attempt = 1) =>
    job.handle(igCtx(attempt), EXECUTE_JOB.payload.parse({ actionId }));
  async function ingestIg(c: { mediaId: string; commentId: string }): Promise<string> {
    const r = await ingest.handle(
      igCtx(1, INGEST_JOB.type),
      INGEST_JOB.payload.parse({
        sourceExternalId: c.mediaId,
        commentExternalId: c.commentId,
        event: 'created',
        platformEventSec: Math.floor(nowMs / 1000),
        changeId: '0123456789abcdef',
      }),
    );
    return r.commentId as string;
  }
  async function requestIg(commentId: string, kind: ActionKind, text?: string): Promise<string> {
    const r = await actions.request({
      scope: t,
      commentId,
      kind,
      actor: { type: 'user', userId: t.userId },
      requestKey: `rk-${randomUUID()}`,
      ...(text !== undefined ? { text } : {}),
    });
    if (r.status !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(r)}`);
    return r.action.id;
  }
  const expectResyncOf = (c: { mediaId: string; commentId: string }) => {
    expect(resync).toHaveBeenCalledTimes(1);
    const req = resync.mock.calls[0]![0];
    expect(req).toEqual({
      scope: igScope,
      platform: 'instagram',
      type: INGEST_JOB.type,
      payload: {
        sourceExternalId: c.mediaId,
        commentExternalId: c.commentId,
        event: 'updated',
        platformEventSec: expect.any(Number),
        changeId: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    });
    // A valid ingest payload, so the job framework accepts it.
    expect(INGEST_JOB.payload.safeParse(req.payload).success).toBe(true);
  };

  beforeEach(async () => {
    igUserId = graph.addInstagramAccount(pageId, { username: 'shop.official' }).igUserId;
    // FakeGraph reuses Instagram ids per case: one live connection per account.
    await ctx.c.query(
      `UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected'
        WHERE platform = 'instagram' AND external_account_id = $1`,
      [igUserId],
    );
    const r = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'instagram', $3) RETURNING id`,
      [t.organizationId, t.brandId, igUserId],
    );
    igScope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: r.rows[0]!.id };
    // Instagram via Facebook Login acts with the linked Page's token.
    await creds.put(igScope, 'access_token', new Secret(pageToken), null);
    const c = graph.addIgComment(igUserId, { text: 'spam here', createdAtMs: nowMs - 60_000 });
    ig = { ...c, id: await ingestIg(c) };
  });

  it('instagram hide applies, records undo unhide, comment hidden, audit written', async () => {
    const actionId = await requestIg(ig.id, 'hide');
    expect(await runIg(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: 'unhide' });
    expect(graph.igState(ig.commentId)).toBe('hidden');
    expect(await actionRow(actionId)).toMatchObject({
      status: 'applied',
      outcome_code: null,
      undo_kind: 'unhide',
      completed_at: expect.any(Date),
    });
    expect((await store.load(t, ig.id))?.platformState).toBe('hidden');
    expect(await auditFor(actionId)).toEqual([
      {
        actor_type: 'user',
        actor_user_id: t.userId,
        action: 'comment.moderated',
        subject_type: 'comment',
        subject_id: ig.id,
        brand_id: t.brandId,
        details: { actionId, kind: 'hide', status: 'applied', outcomeCode: null },
      },
    ]);
    expect(resync).not.toHaveBeenCalled();
  });

  it('instagram unhide applies and comment visible', async () => {
    await runIg(await requestIg(ig.id, 'hide'));
    const actionId = await requestIg(ig.id, 'unhide');
    expect(await runIg(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: 'hide' });
    expect(graph.igState(ig.commentId)).toBe('visible');
    expect((await store.load(t, ig.id))?.platformState).toBe('visible');
  });

  it('instagram delete applies and comment deleted; history retained', async () => {
    const hide = await requestIg(ig.id, 'hide');
    await runIg(hide);
    const actionId = await requestIg(ig.id, 'delete');
    expect(await runIg(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    expect(graph.igState(ig.commentId)).toBe('deleted');
    expect(await store.load(t, ig.id)).toMatchObject({
      platformState: 'deleted',
      body: 'spam here',
    });
    expect((await actions.list(t, ig.id)).map((a) => [a.kind, a.status])).toEqual([
      ['hide', 'applied'],
      ['delete', 'applied'],
    ]);
    expect(resync).not.toHaveBeenCalled();
  });

  it('instagram delete of a comment the owner already deleted -> noop comment_gone; comment deleted; resync enqueued', async () => {
    const actionId = await requestIg(ig.id, 'delete');
    graph.ownerDeletes(ig.commentId);
    expect(await runIg(actionId)).toEqual({
      status: 'noop',
      outcomeCode: 'comment_gone',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_gone',
    });
    expect((await store.load(t, ig.id))?.platformState).toBe('deleted');
    expectResyncOf(ig);
  });

  it('instagram public reply posts under the comment; reply to nested goes to top-level', async () => {
    const top = await requestIg(ig.id, 'public_reply', 'thanks for writing');
    expect(await runIg(top)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    const first = graph.igReplies(ig.commentId);
    expect(first).toEqual([
      { id: expect.any(String), text: 'thanks for writing', fromId: igUserId },
    ]);
    expect(await actionRow(top)).toMatchObject({ status: 'applied', platform_ref: first[0]!.id });

    const nested = graph.addIgComment(igUserId, { parentId: ig.commentId, text: 'a reply' });
    const nestedId = await ingestIg(nested);
    expect((await store.load(t, nestedId))?.parentExternalId).toBe(ig.commentId);
    const onNested = await requestIg(nestedId, 'public_reply', 'replying in thread');
    expect(await runIg(onNested)).toMatchObject({ status: 'applied' });
    expect(graph.igReplies(nested.commentId)).toEqual([]);
    expect(
      graph
        .igReplies(ig.commentId)
        .filter((r) => r.fromId === igUserId)
        .map((r) => r.text),
    ).toEqual(['thanks for writing', 'replying in thread']);
  });

  it('instagram public reply attempt 2 finds the attempt-1 reply via listReplies and does not post twice', async () => {
    const actionId = await requestIg(ig.id, 'public_reply', 'we are on it');
    // Attempt 1 posted the reply, then crashed before recording it.
    const client = await runtime.connect(igScope);
    const first = await client.respond({
      kind: 'public_reply',
      target: { sourceExternalId: ig.mediaId, externalId: ig.commentId },
      text: 'we are on it',
    });
    if (first.status !== 'sent') throw new Error('expected sent');
    const before = graph.calls().length;
    nowMs += 5_000;
    expect(await runIg(actionId, 2)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    const replies = graph.igReplies(ig.commentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.id).toBe(first.platformRef);
    expect(await actionRow(actionId)).toMatchObject({
      status: 'applied',
      platform_ref: first.platformRef,
    });
    expect(graph.calls().slice(before)).toEqual([
      { method: 'GET', path: expect.stringMatching(new RegExp(`${ig.commentId}/replies$`)) },
    ]);
  });

  it('instagram public reply attempt 2 posts when no earlier reply matches', async () => {
    const actionId = await requestIg(ig.id, 'public_reply', 'second try');
    // Same text by someone else does not count.
    graph.addIgComment(igUserId, { parentId: ig.commentId, text: 'second try' });
    expect(await runIg(actionId, 2)).toMatchObject({ status: 'applied' });
    expect(
      graph.igReplies(ig.commentId).filter((r) => r.fromId === igUserId && r.text === 'second try'),
    ).toHaveLength(1);
  });

  it('instagram private reply sends exactly one DM', async () => {
    const actionId = await requestIg(ig.id, 'private_reply', 'check your inbox');
    expect(await runIg(actionId)).toEqual({ status: 'applied', outcomeCode: null, undo: null });
    expect(graph.igPrivateReplies(ig.commentId)).toEqual(['check your inbox']);
    // A redelivery after success does nothing.
    expect(await runIg(actionId, 2)).toEqual({ status: 'applied' });
    expect(graph.igPrivateReplies(ig.commentId)).toEqual(['check your inbox']);
    // And a second request is refused up front.
    const again = await actions.request({
      scope: t,
      commentId: ig.id,
      kind: 'private_reply',
      actor: { type: 'user', userId: t.userId },
      requestKey: `rk-${randomUUID()}`,
      text: 'again',
    });
    expect(again).toMatchObject({
      status: 'recorded',
      action: { status: 'not_eligible', outcomeCode: 'private_reply_already_sent' },
    });
  });

  it('instagram private reply refused by Instagram (window) -> not_eligible and a resync ingest is enqueued', async () => {
    const actionId = await requestIg(ig.id, 'private_reply', 'late message');
    graph.failNext(10, 2018278);
    expect(await runIg(actionId)).toEqual({
      status: 'not_eligible',
      outcomeCode: 'private_reply_window_closed',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'not_eligible',
      outcome_code: 'private_reply_window_closed',
    });
    expect(graph.igPrivateReplies(ig.commentId)).toEqual([]);
    expectResyncOf(ig);
  });

  it('instagram throttled -> row stays pending, job throws rate_limited (never reported as success)', async () => {
    const actionId = await requestIg(ig.id, 'hide');
    graph.throttleNext();
    const err = await runIg(actionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: expect.any(Number) });
    expect(classifyFailure(err).kind).toBe('rate_limited');
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending', completed_at: null });
    expect(await auditFor(actionId)).toEqual([]);
    expect(graph.igState(ig.commentId)).toBe('visible');
    expect(resync).not.toHaveBeenCalled();
  });

  it('instagram permission lost -> row pending, connection reconnect_required', async () => {
    const actionId = await requestIg(ig.id, 'hide');
    graph.failNext(200);
    graph.failNext(200);
    const err = await runIg(actionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'auth_expired', reauthorize: true });
    expect(classifyFailure(err).kind).toBe('needs_reconnection');
    expect(await actionRow(actionId)).toMatchObject({ status: 'pending', completed_at: null });
    const conn = await pool.query('SELECT status FROM connection WHERE id = $1', [
      igScope.connectionId,
    ]);
    expect(conn.rows[0].status).toBe('reconnect_required');
    expect(resync).not.toHaveBeenCalled();
  });

  it('unknown instagram refusal -> failed instagram_error_<code>_<subcode>; outcome contains no graph message', async () => {
    const actionId = await requestIg(ig.id, 'hide');
    graph.failNext(1234, 5678);
    const result = await runIg(actionId);
    expect(result).toEqual({
      status: 'failed',
      outcomeCode: 'instagram_error_1234_5678',
      undo: null,
    });
    const row = await actionRow(actionId);
    expect(row).toMatchObject({ status: 'failed', outcome_code: 'instagram_error_1234_5678' });
    const audit = await auditFor(actionId);
    for (const out of [result, row, audit, lines])
      expect(JSON.stringify(out)).not.toContain('fake graph error');
    expectResyncOf(ig);
  });

  it('a resync enqueue failure is logged and the recorded status is unchanged', async () => {
    const actionId = await requestIg(ig.id, 'delete');
    graph.ownerDeletes(ig.commentId);
    resync.mockRejectedValueOnce(new Error('queue down'));
    expect(await runIg(actionId)).toEqual({
      status: 'noop',
      outcomeCode: 'comment_gone',
      undo: null,
    });
    expect(await actionRow(actionId)).toMatchObject({
      status: 'noop',
      outcome_code: 'comment_gone',
    });
    expect(await auditFor(actionId)).toHaveLength(1);
    const logged = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'moderation.resync_not_queued');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actionId });
    expect(JSON.stringify(logged)).not.toContain(ig.commentId);
    expect(JSON.stringify(logged)).not.toContain('queue down');
  });

  it('never logs reply text or tokens', async () => {
    const text = 'private words 9c1e';
    await runIg(await requestIg(ig.id, 'public_reply', text));
    await runIg(await requestIg(ig.id, 'private_reply', text));
    const joined = lines.join('\n');
    expect(joined).not.toContain(text);
    for (const s of graph.issuedSecrets()) expect(joined).not.toContain(s);
  });
});
