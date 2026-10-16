// Decisions on suggestions through the real run store, runner, ModerationActions and the
// moderation_execute job, with FakeGraph as the platform. The queue stand-in deduplicates on
// the job's external ref like the ledger does.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  ConnectorRegistry,
  ConnectorRuntime,
  MemoryRefreshLock,
  PgConnectionDirectory,
  PgCredentialVault,
  REVIEW_GRACE_MS,
  TokenManager,
  createSafeHttp,
  memoryBudget,
  type Clock,
  type Connector,
  type Platform,
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
} from '@feedbouncer/comments';
import type { EnqueueRequest, EnqueueResult, JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { ACTION_RUN_ADVANCE_JOB } from './jobs/specs.js';
import { PgReviewQueue } from './review.js';
import { PgActionRunStore } from './runs.js';
import { ActionRunner, ActionStepOutcomeObserver, actionRunAdvanceJob } from './runner.js';
import type { Audit } from './services.js';
import {
  SUGGESTION_BULK_JOB,
  approveSuggestion,
  bulkDecide,
  dismissSuggestion,
  endReviewModeEarly,
  requestBulkByFilter,
  suggestionBulkJob,
  type SuggestionServiceDeps,
} from './suggestion-service.js';
import type { GatedStep } from './suggestion-plan.js';
import { PgSuggestionStore } from './suggestions.js';
import type { BrandConnectionInfo } from './support.js';
import { seedCommentRow } from './testing.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const quiet = createLogger('actions-suggestion-service-test', 'error', () => {});
const HOUR = 3_600_000;

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let n = 0;
let nowMs = Date.now();
const clock: Clock = { now: () => nowMs };

let t: Tenant;
let scope: ConnectionScope;
let graph: FakeGraph;
let pageId: string;
let store: PgCommentStore;
let runs: PgActionRunStore;
let suggestions: PgSuggestionStore;
let runner: ActionRunner;
let ingest: ReturnType<typeof ingestCommentJob>;
let execute: ReturnType<typeof executeActionJob>;
let advanceJob: ReturnType<typeof actionRunAdvanceJob>;
let bulkJob: ReturnType<typeof suggestionBulkJob>;
let queue: FakeQueue;
let d: SuggestionServiceDeps;

const jobCtx = (s: ConnectionScope, platform: Platform, jobType: string): JobContext => ({
  scope: s,
  platform,
  jobType,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log: quiet,
});

const SPECS: Record<
  string,
  { payload: { parse(p: unknown): unknown }; externalRef(p: never): string }
> = {
  [EXECUTE_JOB.type]: EXECUTE_JOB,
  [INGEST_JOB.type]: INGEST_JOB,
  [ACTION_RUN_ADVANCE_JOB.type]: ACTION_RUN_ADVANCE_JOB,
  [SUGGESTION_BULK_JOB.type]: SUGGESTION_BULK_JOB,
};

class FakeQueue {
  readonly seen = new Set<string>();
  readonly pending: EnqueueRequest[] = [];
  readonly requests: { req: EnqueueRequest; deduplicated: boolean }[] = [];

  enqueue = async (req: EnqueueRequest): Promise<EnqueueResult> => {
    const spec = SPECS[req.type];
    if (!spec) throw new Error(`unknown job type ${req.type}`);
    const payload = spec.payload.parse(req.payload);
    const key = JSON.stringify([
      req.scope.connectionId,
      req.type,
      spec.externalRef(payload as never),
    ]);
    const deduplicated = this.seen.has(key);
    this.requests.push({ req, deduplicated });
    if (deduplicated)
      return { status: 'deduplicated', ledgerId: 'l', jobId: 'j', state: 'completed' } as never;
    this.seen.add(key);
    this.pending.push({ ...req, payload });
    return { status: 'enqueued', ledgerId: 'l', jobId: 'j' };
  };

  async drain(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const req = this.pending.shift();
      if (!req) return;
      const c = jobCtx(req.scope, req.platform, req.type);
      if (req.type === EXECUTE_JOB.type)
        await execute.handle(c, req.payload as { actionId: string });
      else if (req.type === ACTION_RUN_ADVANCE_JOB.type)
        await advanceJob.handle(c, req.payload as { runId: string; settled: number });
      else if (req.type === SUGGESTION_BULK_JOB.type) await bulkJob.handle(c, req.payload as never);
    }
    throw new Error('queue did not drain');
  }

  count(type: string): number {
    return this.requests.filter((r) => r.req.type === type && !r.deduplicated).length;
  }
}

const audit: Audit = async (tx, e) => {
  await tx.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action,
                              subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
    [e.organizationId, e.brandId, e.actorUserId, e.action, e.subjectType, e.subjectId, e.details],
  );
};

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'actions-suggestion-service-test',
    onIdleError: () => {},
  });
  store = new PgCommentStore(pool);
  runs = new PgActionRunStore(pool);
  suggestions = new PgSuggestionStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  nowMs = Date.now();
  t = await seedTenant(ctx.c, `svc${++n}`, { reviewMode: 'on' });
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };
  await ctx.c.query("UPDATE rule SET mode = 'enforce' WHERE id = $1", [t.ruleId]);
  await ctx.c.query("UPDATE app_user SET display_name = 'Dana' WHERE id = $1", [t.userId]);

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  await ctx.c.query(
    "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE external_account_id = $1",
    [pageId],
  );
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    pageId,
    t.connectionId,
  ]);
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  await creds.put(scope, 'access_token', new Secret(page.pageToken), null);

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
  const vault = new PgCredentialVault(creds, pool, quiet);
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log: quiet,
    oauthContext: (c) => ({
      http: http(c),
      signal: AbortSignal.timeout(15_000),
      redirectUri: 'https://app.test/api/v1/oauth/facebook/callback',
    }),
  });
  const runtime = new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget: memoryBudget(),
    clock,
    log: quiet,
    http,
  });

  queue = new FakeQueue();
  const actions = new ModerationActions({
    pool,
    store,
    producer: queue,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock,
    log: quiet,
  });
  ingest = ingestCommentJob({ runtime, directory, store, clock });
  execute = executeActionJob({
    pool,
    runtime,
    log: quiet,
    producer: queue,
    clock,
    outcomes: new ActionStepOutcomeObserver({ runs, producer: queue, log: quiet }),
  });
  runner = new ActionRunner({
    pool,
    runs,
    review: new PgReviewQueue(pool),
    comments: store,
    actions,
    connection: async (s): Promise<BrandConnectionInfo | null> => {
      const caps = registry.get('facebook')?.capabilities;
      return caps
        ? {
            connectionId: s.connectionId,
            platform: 'facebook',
            caps,
            grantedScopes: caps.defaultScopes,
          }
        : null;
    },
    brandName: async () => 'Shop',
    producer: queue,
    clock,
    log: quiet,
  });
  advanceJob = actionRunAdvanceJob(runner);
  d = { pool, suggestions, runs, runner, producer: queue, audit, clock, log: quiet };
  bulkJob = suggestionBulkJob(d);
});

const HIDE: GatedStep[] = [{ type: 'hide' }];
const DELETE: GatedStep[] = [{ type: 'delete', confirmIrreversible: true }];

const setRuleActions = (steps: readonly GatedStep[]) =>
  pool.query('UPDATE rule SET actions = $2::jsonb WHERE id = $1', [
    t.ruleId,
    JSON.stringify(steps),
  ]);

async function ingestedComment(): Promise<{ id: string; externalId: string }> {
  const c = graph.addComment(pageId, { message: 'spam here', createdAtMs: nowMs - 60_000 });
  const r = await ingest.handle(
    jobCtx(scope, 'facebook', INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      sourceExternalId: c.postId,
      commentExternalId: c.commentId,
      event: 'created',
      platformEventSec: Math.floor(nowMs / 1000),
      changeId: '0123456789abcdef',
    }),
  );
  return { id: r.commentId as string, externalId: c.commentId };
}

async function propose(
  commentId: string,
  steps: readonly GatedStep[] = HIDE,
  s: ConnectionScope = scope,
): Promise<string> {
  const r = await suggestions.propose(s, {
    commentId,
    source: { type: 'rule', ref: randomUUID(), ruleId: t.ruleId, alsoMatchedRuleIds: [] },
    steps,
    reason: 'matched',
  });
  if (!('suggestionId' in r)) throw new Error(`skipped: ${r.skipped}`);
  return r.suggestionId;
}

const seedPending = async (steps: readonly GatedStep[] = HIDE) => {
  const c = await ingestedComment();
  return { ...c, sid: await propose(c.id, steps) };
};

const key = () => `k-${randomUUID()}`;
const user = () => ({ userId: t.userId, requestKey: key() });
const statusOf = async (sid: string) =>
  (
    await pool.query<{
      status: string;
      status_reason: string | null;
      decided_by_user_id: string | null;
      decided_at: Date | null;
    }>(
      'SELECT status, status_reason, decided_by_user_id, decided_at FROM action_suggestion WHERE id = $1',
      [sid],
    )
  ).rows[0]!;
const auditRows = async (action: string) =>
  (
    await pool.query<{ details: Record<string, unknown>; subject_type: string }>(
      'SELECT details, subject_type FROM audit_event WHERE brand_id = $1 AND action = $2',
      [t.brandId, action],
    )
  ).rows;
const runCount = async () =>
  (await pool.query('SELECT 1 FROM action_run WHERE brand_id = $1', [t.brandId])).rowCount;
const setWindow = (startedHoursAgo: number) =>
  ctx.c.query(
    `UPDATE connection SET review_mode_started_at = now() - $2 * interval '1 hour',
            review_mode_ends_at = now() - $2 * interval '1 hour' + interval '168 hours'
      WHERE id = $1`,
    [t.connectionId, startedHoursAgo],
  );

describe('approveSuggestion', () => {
  it('approve executes the plan once and logs moderator and time', async () => {
    const { sid, externalId } = await seedPending();
    const res = await approveSuggestion(d, t, sid, user());
    expect(res).toMatchObject({ status: 'approved', steps: ['hide'], dropped: [] });
    await queue.drain();
    expect(graph.state(externalId)).toBe('hidden');
    const row = await statusOf(sid);
    expect(row).toMatchObject({ status: 'approved', decided_by_user_id: t.userId });
    expect(row.decided_at).toBeInstanceOf(Date);
    expect(await auditRows('suggestion.approved')).toEqual([
      {
        subject_type: 'action_suggestion',
        details: { suggestionId: sid, steps: 'hide', sourceCount: 1 },
      },
    ]);
  });

  it('double-submit with the same requestKey replays the same runId; one platform call', async () => {
    const { sid, externalId } = await seedPending();
    const i = user();
    const a = await approveSuggestion(d, t, sid, i);
    const b = await approveSuggestion(d, t, sid, i);
    expect(a.status).toBe('approved');
    expect(b).toMatchObject({ status: 'approved', runId: (a as { runId: string }).runId });
    await queue.drain();
    expect(graph.state(externalId)).toBe('hidden');
    const actions = await pool.query(
      "SELECT 1 FROM moderation_action WHERE kind = 'hide' AND brand_id = $1",
      [t.brandId],
    );
    expect(actions.rowCount).toBe(1);
    expect(await runCount()).toBe(1);
  });

  it('second moderator with another key gets already_handled with the first decider name', async () => {
    const { sid } = await seedPending();
    await approveSuggestion(d, t, sid, user());
    const res = await approveSuggestion(d, t, sid, user());
    expect(res).toMatchObject({
      status: 'refused',
      code: 'already_handled',
      handled: { status: 'approved', decidedByName: 'Dana', decidedAt: expect.any(Date) },
    });
  });

  it('concurrent approve and dismiss: exactly one wins', async () => {
    const { sid } = await seedPending();
    const results = await Promise.all([
      approveSuggestion(d, t, sid, user()),
      dismissSuggestion(d, t, sid, user()),
    ]);
    expect(
      results.filter((r) => r.status === 'refused' && r.code === 'already_handled'),
    ).toHaveLength(1);
    expect(results.filter((r) => r.status === 'approved' || r.status === 'dismissed')).toHaveLength(
      1,
    );
  });

  it('approve after the comment was deleted -> not_applicable comment_gone, no platform call', async () => {
    const { sid, id, externalId } = await seedPending();
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [id]);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({
      status: 'not_applicable',
      reason: 'comment_gone',
    });
    expect(await statusOf(sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_gone',
    });
    await queue.drain();
    expect(graph.state(externalId)).not.toBe('hidden');
    expect(await runCount()).toBe(0);
  });

  it('approve after the comment was edited -> not_applicable comment_edited', async () => {
    const { sid, id } = await seedPending();
    await ctx.c.query("UPDATE comment SET body = 'edited' WHERE id = $1", [id]);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({
      status: 'not_applicable',
      reason: 'comment_edited',
    });
    expect(await statusOf(sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_edited',
    });
  });

  it('approve when the connection needs reconnect -> refused; suggestion still pending', async () => {
    const { sid } = await seedPending();
    await ctx.c.query("UPDATE connection SET status = 'reconnect_required' WHERE id = $1", [
      t.connectionId,
    ]);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({
      status: 'refused',
      code: 'connection_needs_reconnect',
    });
    expect(await statusOf(sid)).toMatchObject({ status: 'pending', decided_at: null });
    expect(await runCount()).toBe(0);
  });

  it('approve after the window ended but within grace works', async () => {
    const { sid, externalId } = await seedPending();
    await setWindow(169);
    const res = await approveSuggestion(d, t, sid, user());
    expect(res.status).toBe('approved');
    await queue.drain();
    expect(graph.state(externalId)).toBe('hidden');
  });

  it('approve after grace -> expired, nothing runs', async () => {
    const { sid, externalId } = await seedPending();
    await setWindow(168 + REVIEW_GRACE_MS / HOUR + 10);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({ status: 'expired' });
    expect(await statusOf(sid)).toMatchObject({
      status: 'expired',
      status_reason: 'grace_period_ended',
    });
    await queue.drain();
    expect(graph.state(externalId)).not.toBe('hidden');
    expect(await runCount()).toBe(0);
  });

  it('approve of a deleted comment past grace -> not_applicable, as the list shows', async () => {
    const { sid, id } = await seedPending();
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [id]);
    await setWindow(168 + REVIEW_GRACE_MS / HOUR + 10);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({
      status: 'not_applicable',
      reason: 'comment_gone',
    });
    expect(await statusOf(sid)).toMatchObject({ status_reason: 'comment_gone' });
  });

  it('approve with delete in the plan requires confirm', async () => {
    await setRuleActions(DELETE);
    const { sid } = await seedPending(DELETE);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({
      status: 'refused',
      code: 'confirmation_required',
    });
    expect(await statusOf(sid)).toMatchObject({ status: 'pending' });
    const res = await approveSuggestion(d, t, sid, { ...user(), confirm: true });
    expect(res).toMatchObject({ status: 'approved', steps: ['delete'] });
  });

  it('rule disabled after proposal -> approve returns withdrawn', async () => {
    const { sid } = await seedPending();
    await ctx.c.query('UPDATE rule SET enabled = false WHERE id = $1', [t.ruleId]);
    expect(await approveSuggestion(d, t, sid, user())).toEqual({ status: 'withdrawn' });
    expect(await statusOf(sid)).toMatchObject({
      status: 'withdrawn',
      status_reason: 'rule_changed',
    });
    expect(await runCount()).toBe(0);
  });

  it('is not_found for another brand', async () => {
    const { sid } = await seedPending();
    const other = await seedTenant(ctx.c, `svcx${++n}`, { reviewMode: 'on' });
    expect(
      await approveSuggestion(d, other, sid, { userId: other.userId, requestKey: key() }),
    ).toEqual({
      status: 'refused',
      code: 'not_found',
    });
  });
});

describe('dismissSuggestion', () => {
  it('dismiss executes nothing and is logged', async () => {
    const { sid, externalId } = await seedPending();
    const i = user();
    expect(await dismissSuggestion(d, t, sid, i)).toEqual({ status: 'dismissed' });
    expect(await dismissSuggestion(d, t, sid, i)).toEqual({ status: 'dismissed' });
    await queue.drain();
    expect(graph.state(externalId)).not.toBe('hidden');
    expect(await runCount()).toBe(0);
    expect(await statusOf(sid)).toMatchObject({
      status: 'dismissed',
      decided_by_user_id: t.userId,
    });
    expect(await auditRows('suggestion.dismissed')).toHaveLength(1);
  });
});

describe('bulk', () => {
  const seedPlain = async () => propose((await seedCommentRow(ctx.c, t, 'buy now')).id);

  it('bulk approve of 3 ids returns per-item results', async () => {
    const [a, b, c] = [await seedPlain(), await seedPlain(), await seedPlain()] as [
      string,
      string,
      string,
    ];
    await dismissSuggestion(d, t, b, user());
    const res = await bulkDecide(d, t, { action: 'approve', ids: [a, b, c], ...user() });
    expect(res.map((r) => [r.id, r.result.status])).toEqual([
      [a, 'approved'],
      [b, 'refused'],
      [c, 'approved'],
    ]);
    expect(res[1]!.result).toMatchObject({ code: 'already_handled' });
    const runIds = res.flatMap((r) => (r.result.status === 'approved' ? [r.result.runId] : []));
    expect(new Set(runIds).size).toBe(2);
  });

  it('bulk stops for the connection that needs reconnect', async () => {
    const [a, b] = [await seedPlain(), await seedPlain()] as [string, string];
    await ctx.c.query("UPDATE connection SET status = 'reconnect_required' WHERE id = $1", [
      t.connectionId,
    ]);
    const res = await bulkDecide(d, t, { action: 'approve', ids: [a, b], ...user() });
    expect(res.map((r) => r.result)).toEqual([
      { status: 'refused', code: 'connection_needs_reconnect' },
      { status: 'refused', code: 'connection_needs_reconnect' },
    ]);
  });

  it('bulk stops for the connection that is inactive', async () => {
    const [a, b] = [await seedPlain(), await seedPlain()] as [string, string];
    await ctx.c.query("UPDATE connection SET status = 'paused' WHERE id = $1", [
      t.connectionId,
    ]);
    const res = await bulkDecide(d, t, { action: 'approve', ids: [a, b], ...user() });
    expect(res.map((r) => r.result)).toEqual([
      { status: 'refused', code: 'connection_inactive' },
      { status: 'refused', code: 'connection_inactive' },
    ]);
  });

  it('bulk by filter authorId processes all of that author pending suggestions across batches', async () => {
    const other = await ctx.c.query<{ id: string }>(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, 'other-author', 'Other') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId],
    );
    for (let i = 0; i < 150; i++)
      await propose((await seedCommentRow(ctx.c, t, `spam ${i}`, { authorId: t.authorId })).id);
    const kept = await propose(
      (await seedCommentRow(ctx.c, t, 'fine', { authorId: other.rows[0]!.id })).id,
    );
    nowMs = Date.now();
    const res = await requestBulkByFilter(d, scope, {
      action: 'dismiss',
      filter: { authorId: t.authorId },
      ...user(),
    });
    expect(res).toEqual({ matched: 150 });
    await queue.drain();
    expect(queue.count(SUGGESTION_BULK_JOB.type)).toBe(2);
    const counts = await pool.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM action_suggestion WHERE brand_id = $1 GROUP BY status',
      [t.brandId],
    );
    expect(counts.rows.sort((x, y) => x.status.localeCompare(y.status))).toEqual([
      { status: 'dismissed', n: 150 },
      { status: 'pending', n: 1 },
    ]);
    expect(await statusOf(kept)).toMatchObject({ status: 'pending' });
    expect(await auditRows('suggestion.bulk_requested')).toEqual([
      {
        subject_type: 'connection',
        details: expect.objectContaining({
          bulkAction: 'dismiss',
          matched: 150,
          authorId: t.authorId,
        }),
      },
    ]);
  });

  it('bulk approve examines suggestions behind 100 or more that stay pending', async () => {
    await setRuleActions(DELETE);
    const hideRule = await pool.query<{ id: string }>(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, enabled, mode)
       SELECT organization_id, brand_id, 'Hide rule', conditions, 'hide', $2::jsonb, enabled, mode
         FROM rule WHERE id = $1 RETURNING id`,
      [t.ruleId, JSON.stringify(HIDE)],
    );
    const stuck: string[] = [];
    for (let i = 0; i < 105; i++)
      stuck.push(await propose((await seedCommentRow(ctx.c, t, `del ${i}`)).id, DELETE));
    const ok: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await suggestions.propose(scope, {
        commentId: (await seedCommentRow(ctx.c, t, `fine ${i}`)).id,
        source: {
          type: 'rule',
          ref: randomUUID(),
          ruleId: hideRule.rows[0]!.id,
          alsoMatchedRuleIds: [],
        },
        steps: HIDE,
        reason: 'matched',
      });
      if (!('suggestionId' in r)) throw new Error(`skipped: ${r.skipped}`);
      ok.push(r.suggestionId);
    }
    nowMs = Date.now();
    const res = await requestBulkByFilter(d, scope, { action: 'approve', filter: {}, ...user() });
    expect(res).toEqual({ matched: 108 });
    await queue.drain();
    expect(queue.count(SUGGESTION_BULK_JOB.type)).toBe(2);
    for (const sid of ok) expect(await statusOf(sid)).toMatchObject({ status: 'approved' });
    const pending = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM action_suggestion WHERE brand_id = $1 AND status = 'pending'",
      [t.brandId],
    );
    expect(pending.rows[0]!.n).toBe(stuck.length);
  });

  it('bulk by filter with nothing matching enqueues nothing', async () => {
    expect(
      await requestBulkByFilter(d, scope, { action: 'dismiss', filter: {}, ...user() }),
    ).toEqual({ matched: 0 });
    expect(queue.pending).toHaveLength(0);
  });
});

describe('endReviewModeEarly', () => {
  const ended = async () =>
    (
      await pool.query<{
        review_mode_ended_at: Date | null;
        review_mode_ended_by_user_id: string | null;
      }>(
        'SELECT review_mode_ended_at, review_mode_ended_by_user_id FROM connection WHERE id = $1',
        [t.connectionId],
      )
    ).rows[0]!;

  it('end early with dismiss dismisses all pending with review_mode_ended', async () => {
    const a = (await seedPending()).sid;
    const b = (await seedPending()).sid;
    expect(await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'dismiss' })).toEqual({
      status: 'ended',
      pendingCount: 2,
    });
    for (const sid of [a, b])
      expect(await statusOf(sid)).toMatchObject({
        status: 'dismissed',
        status_reason: 'review_mode_ended',
        decided_by_user_id: t.userId,
      });
    expect((await ended()).review_mode_ended_by_user_id).toBe(t.userId);
    expect(await auditRows('review_mode.ended_early')).toEqual([
      { subject_type: 'connection', details: { pending: 'dismiss', pendingCount: 2 } },
    ]);
  });

  it('end early with dismiss closes suggestions of deleted or edited comments as not applicable', async () => {
    const kept = (await seedPending()).sid;
    const gone = await seedPending();
    const edited = await seedPending();
    await pool.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [gone.id]);
    await pool.query("UPDATE comment SET body = 'changed' WHERE id = $1", [edited.id]);
    expect(await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'dismiss' })).toEqual({
      status: 'ended',
      pendingCount: 1,
    });
    expect(await statusOf(kept)).toMatchObject({ status: 'dismissed' });
    expect(await statusOf(gone.sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_gone',
      decided_by_user_id: null,
    });
    expect(await statusOf(edited.sid)).toMatchObject({
      status: 'not_applicable',
      status_reason: 'comment_edited',
      decided_by_user_id: null,
    });
  });

  it('end early with leave keeps them pending and grace runs from ended_at', async () => {
    const { sid } = await seedPending();
    await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'leave' });
    expect(await statusOf(sid)).toMatchObject({ status: 'pending' });
    const view = await suggestions.load(t, sid, new Date());
    const endedAt = (await ended()).review_mode_ended_at!;
    expect(view!.status).toBe('pending');
    expect(view!.expiresAt!.getTime()).toBe(endedAt.getTime() + REVIEW_GRACE_MS);
  });

  it('end early with approve approves all pending', async () => {
    const { sid, externalId } = await seedPending();
    nowMs = Date.now();
    await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve', confirm: true });
    await queue.drain();
    expect(await statusOf(sid)).toMatchObject({ status: 'approved' });
    expect(graph.state(externalId)).toBe('hidden');
  });

  it('approve retried after the enqueue failed re-enqueues approve-all', async () => {
    const { sid, externalId } = await seedPending();
    nowMs = Date.now();
    const enqueue = queue.enqueue;
    queue.enqueue = () => Promise.reject(new Error('queue down'));
    try {
      await expect(
        endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve', confirm: true }),
      ).rejects.toThrow('queue down');
    } finally {
      queue.enqueue = enqueue;
    }
    expect(
      await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve', confirm: true }),
    ).toEqual({ status: 'ended', pendingCount: 1 });
    await queue.drain();
    expect(await statusOf(sid)).toMatchObject({ status: 'approved' });
    expect(graph.state(externalId)).toBe('hidden');
  });

  it('approve after ending early with leave -> review_mode_not_active, nothing enqueued', async () => {
    await seedPending();
    await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'leave' });
    expect(
      await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve', confirm: true }),
    ).toEqual({ status: 'refused', code: 'review_mode_not_active' });
    expect(queue.pending).toHaveLength(0);
  });

  it('approve after the window ended naturally -> review_mode_not_active', async () => {
    await seedPending();
    nowMs = Date.now() + 365 * 24 * HOUR;
    expect(
      await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve', confirm: true }),
    ).toEqual({ status: 'refused', code: 'review_mode_not_active' });
    expect(queue.pending).toHaveLength(0);
  });

  it('end early with approve without confirm -> confirmation_required, window still active', async () => {
    await seedPending();
    expect(await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'approve' })).toEqual({
      status: 'refused',
      code: 'confirmation_required',
    });
    expect((await ended()).review_mode_ended_at).toBeNull();
  });

  it('end early twice -> review_mode_not_active', async () => {
    await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'leave' });
    expect(await endReviewModeEarly(d, scope, { userId: t.userId, pending: 'leave' })).toEqual({
      status: 'refused',
      code: 'review_mode_not_active',
    });
  });

  it("end early on another brand's connection -> zero rows", async () => {
    const other = await seedTenant(ctx.c, `svcy${++n}`, { reviewMode: 'on' });
    const foreign = { ...scope, organizationId: other.organizationId, brandId: other.brandId };
    expect(
      await endReviewModeEarly(d, foreign, { userId: other.userId, pending: 'leave' }),
    ).toEqual({
      status: 'refused',
      code: 'review_mode_not_active',
    });
    expect((await ended()).review_mode_ended_at).toBeNull();
  });
});
