// Wires the real ModerationActions and execute job over FakeGraph, so a click is followed through
// the platform call to the row's final state.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  ConnectorRegistry,
  ConnectorRuntime,
  MemoryRefreshLock,
  PgConnectionDirectory,
  PgCredentialVault,
  TokenManager,
  createSafeHttp,
  memoryBudget,
  type Clock,
  type Platform,
  type Connector,
} from '@feedbouncer/connectors';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import {
  EXECUTE_JOB,
  INGEST_JOB,
  ModerationActions,
  PgCommentStore,
  executeActionJob,
  ingestCommentJob,
  type ActionActor,
  type ActionKind,
} from '@feedbouncer/comments';
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgHiddenTodayStore, type HiddenItem } from './hidden-today.js';
import { PgReviewQueue } from './review.js';
import { PgActionRunStore } from './runs.js';
import { undoStep, type Audit } from './services.js';
import { seedEvaluationRow } from './testing.js';
import { unhideHidden } from './unhide.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('actions-unhide-test', 'error', () => {});
const clock: Clock = { now: () => Date.now() };

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let n = 0;
let t: Tenant;
let scope: ConnectionScope;
let graph: FakeGraph;
let pageId: string;
let registry: ConnectorRegistry;
let runtime: ConnectorRuntime;
let actions: ModerationActions;
let exec: ReturnType<typeof executeActionJob>;
let ingest: ReturnType<typeof ingestCommentJob>;
let hidden: PgHiddenTodayStore;
let runs: PgActionRunStore;
let review: PgReviewQueue;

const audit: Audit = async (tx, e) => {
  await tx.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action,
                              subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
    [e.organizationId, e.brandId, e.actorUserId, e.action, e.subjectType, e.subjectId, e.details],
  );
};

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

const deps = () => ({
  pool,
  hidden,
  runs,
  review,
  actions,
  audit,
  caps: (p: Platform) => registry.get(p)?.capabilities ?? null,
  clock,
});
const unhideBy = (id: string, scp = t) => unhideHidden(deps(), scp, id, t.userId);

async function runAction(actionId: string, attempt = 1) {
  return exec.handle(jobCtx(attempt), EXECUTE_JOB.payload.parse({ actionId }));
}

async function request(
  commentId: string,
  kind: ActionKind,
  actor: ActionActor,
  requestKey = `k-${randomUUID()}`,
) {
  return actions.request({ scope: t, commentId, kind, actor, requestKey });
}

/** A comment on the platform, hidden through the real action pipeline. */
async function hiddenComment(
  actor: ActionActor = { type: 'user', userId: t.userId },
  o: { stalePlatform?: boolean } = {},
) {
  const c = graph.addComment(pageId, { message: 'spam here', createdAtMs: Date.now() - 60_000 });
  const r = await ingest.handle(
    jobCtx(1, INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      sourceExternalId: c.postId,
      commentExternalId: c.commentId,
      event: 'created',
      platformEventSec: Math.floor(Date.now() / 1000),
      changeId: '0123456789abcdef',
    }),
  );
  const commentId = r.commentId as string;
  const hide = await request(commentId, 'hide', actor, `rule-eval:${randomUUID()}`);
  if (hide.status !== 'accepted') throw new Error(`hide not accepted: ${JSON.stringify(hide)}`);
  if (o.stalePlatform) {
    // We recorded the hide, but the owner unhid the comment on the platform and we missed it.
    await pool.query(
      "UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1",
      [hide.action.id],
    );
    await pool.query("UPDATE comment SET platform_state = 'hidden' WHERE id = $1", [commentId]);
  } else await runAction(hide.action.id);
  return { ...c, id: commentId, hideId: hide.action.id };
}

const unhides = async (commentId: string) =>
  (
    await pool.query(
      `SELECT id, actor_type, actor_user_id, request_key, reverses_action_id, status, outcome_code
         FROM moderation_action WHERE comment_id = $1 AND kind = 'unhide' ORDER BY created_at, id`,
      [commentId],
    )
  ).rows;

const ok = (r: Awaited<ReturnType<typeof unhideHidden>>): HiddenItem => {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.item;
};

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-unhide-test', onIdleError: () => {} });
  hidden = new PgHiddenTodayStore(pool);
  runs = new PgActionRunStore(pool);
  review = new PgReviewQueue(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  t = await seedTenant(ctx.c, `uh${++n}`);
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => Date.now() });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  await ctx.c.query(
    "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE external_account_id = $1",
    [pageId],
  );
  await ctx.c.query(
    "UPDATE connection SET external_account_id = $1, granted_scopes = ARRAY['pages_manage_engagement'] WHERE id = $2",
    [pageId, t.connectionId],
  );
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  await creds.put(scope, 'access_token', new Secret(page.pageToken), null);

  const meta = {
    appId: '111',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  };
  registry = new ConnectorRegistry();
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
  const store = new PgCommentStore(pool);
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
  exec = executeActionJob({
    pool,
    runtime,
    log,
    producer: {
      enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
    },
    clock,
  });
});

describe('unhideHidden', () => {
  it.each([
    ['person', undefined],
    ['classifier', { type: 'classifier' } as const],
    ['policy', { type: 'policy' } as const],
  ])('unhide of a %s hide creates one user unhide reversing the hide', async (_n, actor) => {
    const h = await hiddenComment(actor);
    const item = ok(await unhideBy(h.hideId));
    expect(item.state).toBe('pending');
    const [u] = await unhides(h.id);
    expect(u).toMatchObject({
      actor_type: 'user',
      actor_user_id: t.userId,
      reverses_action_id: h.hideId,
      request_key: `unhide:${h.hideId}`,
      status: 'pending',
    });
    await runAction(u.id);
    expect(graph.state(h.commentId)).toBe('visible');
    expect(ok(await unhideBy(h.hideId))).toMatchObject({ state: 'restored', canUnhide: false });
    expect(await unhides(h.id)).toHaveLength(1);
  });

  it('unhide of a rule-step hide goes through undoStep and marks the step undone', async () => {
    const h = await hiddenComment({ type: 'rule', ruleId: t.ruleId });
    const stepId = await seedRuleStep(h.id, h.hideId);
    expect(ok(await unhideBy(h.hideId))).toMatchObject({ ruleStepId: stepId, state: 'pending' });
    const [u] = await unhides(h.id);
    expect(u).toMatchObject({ request_key: `undo:${stepId}`, reverses_action_id: h.hideId });
    const step = await runs.loadStep(t, stepId);
    expect(step).toMatchObject({ undoActionId: u.id });
    expect(step!.undoneAt).toBeInstanceOf(Date);
    await runAction(u.id);
    expect(ok(await unhideBy(h.hideId)).state).toBe('restored');
  });

  it('a second sequential call creates no second action', async () => {
    const h = await hiddenComment();
    await unhideBy(h.hideId);
    await unhideBy(h.hideId);
    expect(await unhides(h.id)).toHaveLength(1);
  });

  it('concurrent calls (5) create exactly one unhide action', async () => {
    const h = await hiddenComment();
    const results = await Promise.all(Array.from({ length: 5 }, () => unhideBy(h.hideId)));
    results.forEach((r) => expect(r.status).toBe('ok'));
    expect(await unhides(h.id)).toHaveLength(1);
  });

  it('a rule-step hide unhidden concurrently from undoStep and unhideHidden yields one unhide action', async () => {
    const h = await hiddenComment({ type: 'rule', ruleId: t.ruleId });
    const stepId = await seedRuleStep(h.id, h.hideId);
    const [a, b, c] = await Promise.all([
      undoStep(deps(), t, stepId, t.userId),
      unhideBy(h.hideId),
      unhideBy(h.hideId),
    ]);
    expect(a.status).not.toBe('refused');
    expect(b.status).toBe('ok');
    expect(c.status).toBe('ok');
    const rows = await unhides(h.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request_key: `undo:${stepId}` });
    await runAction(rows[0].id);
    expect(ok(await unhideBy(h.hideId)).state).toBe('restored');
  });

  it('after a failed attempt the next call creates a second attempt keyed on the first', async () => {
    const h = await hiddenComment();
    await unhideBy(h.hideId);
    const [first] = await unhides(h.id);
    graph.failNext(1);
    await runAction(first.id, EXECUTE_JOB.policy.maxAttempts).catch(() => undefined);
    expect((await unhides(h.id))[0]).toMatchObject({ status: 'failed' });
    expect(ok(await unhideBy(h.hideId))).toMatchObject({ state: 'pending' });
    const rows = await unhides(h.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      request_key: `unhide:${h.hideId}:${first.id}`,
      reverses_action_id: h.hideId,
    });
  });

  it('a reconnect_required connection is refused with no action', async () => {
    const h = await hiddenComment();
    await ctx.c.query("UPDATE connection SET status = 'reconnect_required' WHERE id = $1", [
      t.connectionId,
    ]);
    expect(await unhideBy(h.hideId)).toEqual({
      status: 'refused',
      code: 'connection_needs_reconnect',
    });
    expect(await unhides(h.id)).toEqual([]);
    expect((await hidden.load(t, h.hideId, new Date()))?.state).toBe('hidden');
  });

  it('a revoked connection is refused connection_inactive', async () => {
    const h = await hiddenComment();
    await ctx.c.query("UPDATE connection SET status = 'revoked' WHERE id = $1", [t.connectionId]);
    expect(await unhideBy(h.hideId)).toEqual({ status: 'refused', code: 'connection_inactive' });
    expect(await unhides(h.id)).toEqual([]);
  });

  it.each([
    ['facebook', 'pages_manage_engagement'],
    ['instagram', 'instagram_manage_comments'],
  ])('a missing %s scope is refused missing_permission', async (platform, permission) => {
    const h = await hiddenComment();
    await ctx.c.query('UPDATE connection SET granted_scopes = $2, platform = $3 WHERE id = $1', [
      t.connectionId,
      [],
      platform,
    ]);
    expect(await unhideBy(h.hideId)).toEqual({
      status: 'refused',
      code: 'missing_permission',
      permission,
    });
    expect(await unhides(h.id)).toEqual([]);
  });

  it('a comment already visible on the platform ends already_visible', async () => {
    const h = await hiddenComment(undefined, { stalePlatform: true });
    expect(ok(await unhideBy(h.hideId)).state).toBe('pending');
    const [u] = await unhides(h.id);
    await runAction(u.id);
    expect(ok(await unhideBy(h.hideId))).toMatchObject({
      state: 'already_visible',
      canUnhide: false,
    });
  });

  it('a deleted comment is unavailable and a second call writes nothing', async () => {
    const h = await hiddenComment();
    graph.removeComment(h.commentId);
    await unhideBy(h.hideId);
    const [u] = await unhides(h.id);
    await runAction(u.id);
    expect(ok(await unhideBy(h.hideId))).toMatchObject({ state: 'unavailable', canUnhide: false });
    expect(ok(await unhideBy(h.hideId)).state).toBe('unavailable');
    expect(await unhides(h.id)).toHaveLength(1);
  });

  it('after an unhide, rule, classifier and policy hides are refused moderator_override', async () => {
    const h = await hiddenComment();
    await unhideBy(h.hideId);
    const [u] = await unhides(h.id);
    await runAction(u.id);
    const attempts: [ActionActor, string][] = [
      [{ type: 'rule', ruleId: t.ruleId }, `rule-eval:${randomUUID()}`],
      [{ type: 'classifier' }, `clf:${randomUUID()}`],
      [{ type: 'policy' }, `pol:${randomUUID()}`],
    ];
    for (const [actor, key] of attempts)
      expect(await request(h.id, 'hide', actor, key)).toEqual({
        status: 'refused',
        code: 'moderator_override',
      });
    expect(graph.state(h.commentId)).toBe('visible');
  });

  it("brand B's scope with a brand A hide id is not_found", async () => {
    const h = await hiddenComment();
    const other = await seedTenant(ctx.c, `uh${++n}`);
    expect(await unhideBy(h.hideId, other)).toEqual({ status: 'refused', code: 'not_found' });
    expect(await unhides(h.id)).toEqual([]);
  });
});

/** A settled rule run step whose hide is the given applied action. */
async function seedRuleStep(commentId: string, hideId: string): Promise<string> {
  const run = await runs.createRun(t, {
    commentId,
    ruleId: t.ruleId,
    evaluationId: await seedEvaluationRow(ctx.c, { id: commentId, body: '', t }),
    dryRun: false,
    steps: [{ type: 'hide' }],
  });
  const stepId = run.steps[0]!.id;
  await withTransaction(pool, async (tx) => {
    await runs.linkAction(tx, t, stepId, hideId, `auto:${stepId}`);
    await runs.settleStep(tx, t, stepId, { status: 'succeeded', reason: null });
  });
  return stepId;
}
