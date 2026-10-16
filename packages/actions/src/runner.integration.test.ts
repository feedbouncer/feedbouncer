// The per-action matrix: runs go through the real ModerationActions, the real
// moderation_execute job and the connector runtime, with FakeGraph as the
// platform. A small in-memory queue stands in for the job framework: it
// deduplicates on the job's external ref like the ledger does, runs jobs in
// order, and keeps throttled execute jobs aside until the test retries or
// dead-letters them.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  classifyFailure,
  type EnqueueRequest,
  type EnqueueResult,
  type JobContext,
} from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { ACTION_RUN_ADVANCE_JOB } from './jobs/specs.js';
import { PgReviewQueue } from './review.js';
import { PgActionRunStore, type RunRow } from './runs.js';
import {
  ActionRunner,
  ActionStepOutcomeObserver,
  actionRunAdvanceJob,
  type ActionStepObserver,
} from './runner.js';
import type { ActionStep, StepType } from './steps.js';
import { seedEvaluationRow } from './testing.js';
import type { BrandConnectionInfo } from './support.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const quiet = createLogger('actions-runner-test', 'error', () => {});
const DAY = 86_400_000;

const FLAG: ActionStep = { type: 'flag_for_review' };
const HIDE: ActionStep = { type: 'hide' };
const DELETE: ActionStep = { type: 'delete', confirmIrreversible: true };
const BAN: ActionStep = { type: 'ban', confirmHardToReverse: true };
const REPLY: ActionStep = { type: 'auto_reply', template: 'Hi {{author_name}}, thanks!' };
const DM: ActionStep = {
  type: 'private_reply',
  template: 'Hello {{author_first_name}}, check your inbox',
};

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let n = 0;
let nowMs = Date.now();
const clock: Clock = { now: () => nowMs };

let t: Tenant;
let scope: ConnectionScope;
let graph: FakeGraph;
let pageId: string;
let pageToken: string;
let creds: CredentialStore;
let registry: ConnectorRegistry;
let store: PgCommentStore;
let runs: PgActionRunStore;
let review: PgReviewQueue;
let actions: ModerationActions;
let runner: ActionRunner;
let ingest: ReturnType<typeof ingestCommentJob>;
let execute: ReturnType<typeof executeActionJob>;
let advanceJob: ReturnType<typeof actionRunAdvanceJob>;
let queue: FakeQueue;
let logLines: string[];
let settledEvents: Parameters<ActionStepObserver['onStepSettled']>[0][];
/** Granted scopes per connection id; defaults to the connector's default scopes. */
let grantedOverride: Map<string, string[]>;
/** Makes the next review.open throw. */
let failNextReviewOpen: boolean;
/** Makes the next review.open run a SQL statement that errors inside the transaction. */
let failNextReviewSql: boolean;
/** The comment seeded by beforeEach: a stored Facebook comment by someone else. */
let seeded: { postId: string; commentId: string; id: string };

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
};

/** Job framework stand-in: ledger-style dedup on the external ref, FIFO, throttled jobs kept aside. */
class FakeQueue {
  readonly seen = new Set<string>();
  readonly pending: EnqueueRequest[] = [];
  readonly deferred: EnqueueRequest[] = [];
  /** Every enqueue call, deduplicated or not. */
  readonly requests: { req: EnqueueRequest; ref: string; deduplicated: boolean }[] = [];

  enqueue = async (req: EnqueueRequest): Promise<EnqueueResult> => {
    const spec = SPECS[req.type];
    if (!spec) throw new Error(`unknown job type ${req.type}`);
    const payload = spec.payload.parse(req.payload);
    const ref = spec.externalRef(payload as never);
    const key = JSON.stringify([req.scope.connectionId, req.type, ref]);
    const deduplicated = this.seen.has(key);
    this.requests.push({ req, ref, deduplicated });
    if (deduplicated)
      return { status: 'deduplicated', ledgerId: 'l', jobId: 'j', state: 'completed' } as never;
    this.seen.add(key);
    this.pending.push({ ...req, payload });
    return { status: 'enqueued', ledgerId: 'l', jobId: 'j' };
  };

  /** Runs queued jobs (of one type, if given) until none are left. */
  async drain(only?: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      const idx = only ? this.pending.findIndex((r) => r.type === only) : 0;
      if (idx < 0 || this.pending.length === 0) return;
      const [req] = this.pending.splice(idx, 1);
      await this.run(req!);
    }
    throw new Error('queue did not drain');
  }

  async retryDeferred(): Promise<void> {
    // The rate limiter reads the real clock: let it see the time the test moved to.
    vi.setSystemTime(nowMs);
    this.pending.push(...this.deferred.splice(0));
    await this.drain();
  }

  /** The framework gave up on the deferred execute jobs: rate limit budget spent. */
  async deadLetterDeferred(): Promise<void> {
    for (const req of this.deferred.splice(0)) {
      await execute.onDeadLetter?.(
        {
          scope: req.scope,
          platform: req.platform,
          reason: 'rate_limit_exhausted',
          errorCode: 'platform_throttled',
        },
        req.payload as { actionId: string },
      );
    }
    await this.drain();
  }

  private async run(req: EnqueueRequest): Promise<void> {
    const c = jobCtx(req.scope, req.platform, req.type);
    if (req.type === EXECUTE_JOB.type) {
      try {
        await execute.handle(c, req.payload as { actionId: string });
      } catch (err) {
        if (classifyFailure(err).kind !== 'rate_limited') throw err;
        this.deferred.push(req);
      }
    } else if (req.type === ACTION_RUN_ADVANCE_JOB.type) {
      await advanceJob.handle(c, req.payload as { runId: string; settled: number });
    }
    // Resync ingests are not needed here.
  }
}

class FlakyReview extends PgReviewQueue {
  override async open(...a: Parameters<PgReviewQueue['open']>) {
    if (failNextReviewOpen) {
      failNextReviewOpen = false;
      throw new Error('review store down');
    }
    if (failNextReviewSql) {
      failNextReviewSql = false;
      await a[0].query('SELECT 1 / 0');
    }
    return super.open(...a);
  }
}

async function ingestComment(
  s: ConnectionScope,
  platform: Platform,
  c: { sourceExternalId: string; commentExternalId: string },
): Promise<string> {
  const r = await ingest.handle(
    jobCtx(s, platform, INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      ...c,
      event: 'created',
      platformEventSec: Math.floor(nowMs / 1000),
      changeId: '0123456789abcdef',
    }),
  );
  return r.commentId as string;
}

async function addFbComment(
  o: Parameters<FakeGraph['addComment']>[1] = {},
): Promise<{ postId: string; commentId: string; id: string }> {
  const c = graph.addComment(pageId, { message: 'spam here', createdAtMs: nowMs - 60_000, ...o });
  const id = await ingestComment(scope, 'facebook', {
    sourceExternalId: c.postId,
    commentExternalId: c.commentId,
  });
  return { ...c, id };
}

const newEvaluation = (s: ConnectionScope, commentId: string): Promise<string> =>
  seedEvaluationRow(ctx.c, { id: commentId, body: '', t: { ...t, connectionId: s.connectionId } });

async function start(
  steps: readonly ActionStep[],
  o: { commentId?: string; evaluationId?: string; dryRun?: boolean; s?: ConnectionScope } = {},
): Promise<RunRow> {
  const s = o.s ?? scope;
  const commentId = o.commentId ?? seeded.id;
  return runner.start(s, {
    commentId,
    ruleId: t.ruleId,
    evaluationId: o.evaluationId ?? (await newEvaluation(s, commentId)),
    dryRun: o.dryRun ?? false,
    steps,
  });
}

interface StepDb {
  status: string;
  reason_code: string | null;
  moderation_action_id: string | null;
  review_item_id: string | null;
  preview_text: string | null;
}
const stepOf = async (runId: string, type: StepType): Promise<StepDb> =>
  (
    await pool.query<StepDb>(
      `SELECT status, reason_code, moderation_action_id, review_item_id, preview_text
         FROM action_run_step WHERE run_id = $1 AND step_type = $2`,
      [runId, type],
    )
  ).rows[0]!;
const outcome = async (runId: string, type: StepType) => {
  const s = await stepOf(runId, type);
  return [s.status, s.reason_code];
};
const runCompleted = async (runId: string) =>
  (await pool.query('SELECT completed_at FROM action_run WHERE id = $1', [runId])).rows[0]
    .completed_at !== null;
const actionsOf = async (commentId: string) =>
  (
    await pool.query<{ kind: string; status: string; request_key: string; actor_type: string }>(
      `SELECT kind, status, request_key, actor_type FROM moderation_action
        WHERE comment_id = $1 ORDER BY created_at, id`,
      [commentId],
    )
  ).rows;
const reviewItems = async (commentId: string) =>
  (
    await pool.query<{ id: string; status: string; source: string }>(
      'SELECT id, status, source FROM review_item WHERE comment_id = $1',
      [commentId],
    )
  ).rows;
const authorOf = async (commentId: string) => (await store.load(t, commentId))!.authorExternalId!;
const ourReplies = (c: { commentId: string }) =>
  graph.replies(c.commentId).filter((r) => r.fromId === pageId);

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-runner-test', onIdleError: () => {} });
  store = new PgCommentStore(pool);
  runs = new PgActionRunStore(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  nowMs = Date.now();
  t = await seedTenant(ctx.c, `run${++n}`);
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };
  grantedOverride = new Map();
  failNextReviewOpen = false;
  failNextReviewSql = false;
  settledEvents = [];
  logLines = [];

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  pageToken = page.pageToken;
  // Fresh FakeGraphs reuse Page ids: one live connection per Page.
  await ctx.c.query(
    "UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE external_account_id = $1",
    [pageId],
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
  registry = new ConnectorRegistry();
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
  review = new FlakyReview(pool);
  actions = new ModerationActions({
    pool,
    store,
    producer: queue,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock,
    log: quiet,
  });
  const log = createLogger('actions-runner-test', 'debug', (l) => logLines.push(l));
  ingest = ingestCommentJob({ runtime, directory, store, clock });
  execute = executeActionJob({
    pool,
    runtime,
    log: quiet,
    producer: queue,
    clock,
    outcomes: new ActionStepOutcomeObserver({ runs, producer: queue, log }),
  });
  runner = new ActionRunner({
    pool,
    runs,
    review,
    comments: store,
    actions,
    connection: async (s): Promise<BrandConnectionInfo | null> => {
      const r = await pool.query<{ platform: Platform }>(
        'SELECT platform FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
        [s.organizationId, s.brandId, s.connectionId],
      );
      const platform = r.rows[0]?.platform;
      const caps = platform ? registry.get(platform)?.capabilities : undefined;
      if (!platform || !caps) return null;
      return {
        connectionId: s.connectionId,
        platform,
        caps,
        grantedScopes: grantedOverride.get(s.connectionId) ?? caps.defaultScopes,
      };
    },
    brandName: async () => 'Shop',
    producer: queue,
    clock,
    log,
    observer: { onStepSettled: async (e) => void settledEvents.push(e) },
  });
  advanceJob = actionRunAdvanceJob(runner);

  seeded = await addFbComment();
});

/** Per step type: the steps of a run, its platform effect, and a companion step for the failure case. */
const MATRIX: Record<
  StepType,
  {
    step: ActionStep;
    effect: () => Promise<boolean>;
    /** Steps for the failure case; the first is the step under test. */
    failureRun: readonly ActionStep[];
    companion: StepType;
  }
> = {
  hide: {
    step: HIDE,
    effect: async () => graph.state(seeded.commentId) === 'hidden',
    failureRun: [HIDE, BAN],
    companion: 'ban',
  },
  delete: {
    step: DELETE,
    effect: async () => graph.state(seeded.commentId) === 'deleted',
    failureRun: [DELETE, FLAG],
    companion: 'flag_for_review',
  },
  ban: {
    step: BAN,
    effect: async () =>
      JSON.stringify(graph.blocked(pageId)) === JSON.stringify([await authorOf(seeded.id)]),
    failureRun: [BAN, DELETE],
    companion: 'delete',
  },
  auto_reply: {
    step: REPLY,
    effect: async () => ourReplies(seeded).length === 1,
    failureRun: [REPLY, BAN],
    companion: 'ban',
  },
  private_reply: {
    step: DM,
    effect: async () => graph.privateReplies(seeded.commentId).length === 1,
    failureRun: [DM, REPLY],
    companion: 'auto_reply',
  },
  flag_for_review: {
    step: FLAG,
    effect: async () =>
      (await reviewItems(seeded.id)).filter((i) => i.status === 'open').length === 1,
    failureRun: [FLAG, HIDE],
    companion: 'hide',
  },
};

describe.each(Object.keys(MATRIX) as StepType[])('%s step', (type) => {
  const m = MATRIX[type];

  it('success: succeeded with the platform effect visible', async () => {
    const run = await start([m.step]);
    await queue.drain();
    const s = await stepOf(run.id, type);
    expect([s.status, s.reason_code]).toEqual(['succeeded', null]);
    expect(await m.effect()).toBe(true);
    expect(await runCompleted(run.id)).toBe(true);
    if (type === 'flag_for_review') {
      const items = await reviewItems(seeded.id);
      expect(items).toEqual([{ id: s.review_item_id, status: 'open', source: 'action_step' }]);
      expect(await actionsOf(seeded.id)).toEqual([]);
    } else {
      expect(await actionsOf(seeded.id)).toEqual([
        {
          kind: expect.any(String),
          status: 'applied',
          request_key: expect.stringMatching(new RegExp(`^auto:${seeded.id}:`)),
          actor_type: 'rule',
        },
      ]);
    }
    expect(settledEvents).toEqual([
      {
        scope,
        runId: run.id,
        stepId: run.steps[0]!.id,
        ruleId: t.ruleId,
        evaluationId: run.evaluationId,
        commentId: seeded.id,
        type,
        status: 'succeeded',
        reason: null,
      },
    ]);
  });

  it('failure: the step fails with its code and the other step still runs', async () => {
    if (type === 'flag_for_review') failNextReviewOpen = true;
    else graph.failNext(10);
    const run = await start(m.failureRun);
    await queue.drain();
    expect(await outcome(run.id, type)).toEqual(
      type === 'flag_for_review' ? ['failed', 'internal_error'] : ['failed', 'missing_permission'],
    );
    expect(await outcome(run.id, m.companion)).toEqual(['succeeded', null]);
    expect(await runCompleted(run.id)).toBe(true);
  });

  it('retry: pending / rate_limited while throttled, then succeeded with one effect', async () => {
    if (type === 'flag_for_review') {
      // No platform call to throttle: a repeated start and advance still leave one item.
      const run = await start([m.step]);
      await start([m.step], { evaluationId: run.evaluationId });
      await queue.drain();
      await runner.advance(scope, run.id);
      expect(await outcome(run.id, type)).toEqual(['succeeded', null]);
      expect(await reviewItems(seeded.id)).toHaveLength(1);
      return;
    }
    graph.throttleNext();
    const run = await start([m.step]);
    await queue.drain();
    expect(await outcome(run.id, type)).toEqual(['pending', 'rate_limited']);
    expect(await runCompleted(run.id)).toBe(false);
    nowMs += 5 * 60_000;
    await queue.retryDeferred();
    expect(await outcome(run.id, type)).toEqual(['succeeded', null]);
    expect(await m.effect()).toBe(true);
    expect((await actionsOf(seeded.id)).map((a) => a.status)).toEqual(['applied']);
  });

  it('duplicate: one action per kind; a later evaluation of the comment is skipped', async () => {
    const first = await start([m.step]);
    await queue.drain(ACTION_RUN_ADVANCE_JOB.type);
    const again = await start([m.step], { evaluationId: first.evaluationId });
    expect(again.id).toBe(first.id);
    // An edit: a new evaluation of the same comment.
    const second = await start([m.step]);
    await queue.drain();
    expect(await outcome(first.id, type)).toEqual(['succeeded', null]);
    expect(await outcome(second.id, type)).toEqual(
      type === 'flag_for_review' ? ['skipped', 'already_flagged'] : ['skipped', 'duplicate'],
    );
    const kinds = (await actionsOf(seeded.id)).map((a) => a.kind);
    expect(kinds).toHaveLength(new Set(kinds).size);
    expect(kinds).toHaveLength(type === 'flag_for_review' ? 0 : 1);
    expect(await reviewItems(seeded.id)).toHaveLength(type === 'flag_for_review' ? 1 : 0);
    expect(await m.effect()).toBe(true);
  });

  it('already removed (stored as deleted): comment_gone; ban still attempted; flag still succeeds', async () => {
    await ctx.c.query("UPDATE comment SET platform_state = 'deleted' WHERE id = $1", [seeded.id]);
    const run = await start([m.step]);
    await queue.drain();
    if (type === 'ban' || type === 'flag_for_review') {
      expect(await outcome(run.id, type)).toEqual(['succeeded', null]);
      expect(await m.effect()).toBe(true);
    } else {
      expect(await outcome(run.id, type)).toEqual(['not_applicable', 'comment_gone']);
      expect(await actionsOf(seeded.id)).toEqual([]);
    }
  });

  it('already removed (platform answers not found): comment_gone; ban still attempted', async () => {
    graph.removeComment(seeded.commentId);
    const run = await start([m.step]);
    await queue.drain();
    if (type === 'ban' || type === 'flag_for_review') {
      expect(await outcome(run.id, type)).toEqual(['succeeded', null]);
    } else {
      expect(await outcome(run.id, type)).toEqual(['not_applicable', 'comment_gone']);
    }
    if (type === 'ban')
      expect((await actionsOf(seeded.id)).map((a) => a.kind)).toEqual(['ban_author']);
  });
});

describe('action runner', () => {
  it('steps run in STEP_ORDER and delete waits until every earlier step is final', async () => {
    const run = await start([DELETE, BAN, FLAG]);
    expect(run.steps.map((s) => s.type)).toEqual(['flag_for_review', 'ban', 'delete']);
    await queue.drain(ACTION_RUN_ADVANCE_JOB.type);
    expect(await outcome(run.id, 'flag_for_review')).toEqual(['succeeded', null]);
    expect(await outcome(run.id, 'ban')).toEqual(['pending', null]);
    expect((await stepOf(run.id, 'ban')).moderation_action_id).not.toBeNull();
    expect((await stepOf(run.id, 'delete')).moderation_action_id).toBeNull();
    expect((await actionsOf(seeded.id)).map((a) => a.kind)).toEqual(['ban_author']);

    await queue.drain();
    expect(await outcome(run.id, 'ban')).toEqual(['succeeded', null]);
    expect(await outcome(run.id, 'delete')).toEqual(['succeeded', null]);
    expect((await actionsOf(seeded.id)).map((a) => a.kind)).toEqual(['ban_author', 'delete']);
    expect(graph.state(seeded.commentId)).toBe('deleted');
    expect(await runCompleted(run.id)).toBe(true);
    expect(settledEvents.map((e) => e.type)).toEqual(['flag_for_review', 'ban', 'delete']);
  });

  it('a deferred step blocks only delete; other later steps are still requested', async () => {
    graph.throttleNext();
    const run = await start([DM, REPLY]);
    await queue.drain();
    expect(await outcome(run.id, 'private_reply')).toEqual(['pending', 'rate_limited']);
    // The platform now throttles the whole connection, so the reply waits too, but it was asked for.
    expect((await stepOf(run.id, 'auto_reply')).moderation_action_id).not.toBeNull();

    nowMs += 5 * 60_000;
    await queue.retryDeferred();
    expect(await outcome(run.id, 'private_reply')).toEqual(['succeeded', null]);
    expect(await outcome(run.id, 'auto_reply')).toEqual(['succeeded', null]);
    expect(ourReplies(seeded)).toHaveLength(1);
  });

  it('a deferred then applied step still advances the run (distinct wake-up refs)', async () => {
    graph.throttleNext();
    const run = await start([DELETE, DM, FLAG]);
    await queue.drain();
    expect(await outcome(run.id, 'private_reply')).toEqual(['pending', 'rate_limited']);
    expect(await outcome(run.id, 'delete')).toEqual(['pending', null]);
    expect((await actionsOf(seeded.id)).map((a) => a.kind)).toEqual(['private_reply']);

    nowMs += 5 * 60_000;
    await queue.retryDeferred();
    expect(await outcome(run.id, 'private_reply')).toEqual(['succeeded', null]);
    expect(await outcome(run.id, 'delete')).toEqual(['succeeded', null]);
    expect(graph.state(seeded.commentId)).toBe('deleted');
    expect(await runCompleted(run.id)).toBe(true);

    const dmStep = run.steps.find((s) => s.type === 'private_reply')!.id;
    const wakes = queue.requests
      .filter((r) => r.req.type === ACTION_RUN_ADVANCE_JOB.type)
      .map((r) => r.ref);
    expect(wakes).toContain(`run:${run.id}:2:${dmStep}:deferred`);
    expect(wakes).toContain(`run:${run.id}:2:${dmStep}:applied`);
  });

  it('rate limit exhausted: pending then failed / rate_limit_exhausted (dead-letter hook)', async () => {
    graph.throttleNext();
    const run = await start([HIDE]);
    await queue.drain();
    expect(await outcome(run.id, 'hide')).toEqual(['pending', 'rate_limited']);
    await queue.deadLetterDeferred();
    expect(await outcome(run.id, 'hide')).toEqual(['failed', 'rate_limit_exhausted']);
    expect(await runCompleted(run.id)).toBe(true);
    expect(graph.state(seeded.commentId)).toBe('visible');
  });

  it('an advance job that dead-letters settles the run: unrun steps fail with retries_exhausted', async () => {
    const run = await start([FLAG, HIDE]);
    await advanceJob.onDeadLetter?.(
      { scope, platform: 'facebook', reason: 'retries_exhausted', errorCode: 'internal_error' },
      { runId: run.id, settled: 0 },
    );
    expect(await outcome(run.id, 'flag_for_review')).toEqual(['failed', 'retries_exhausted']);
    expect(await outcome(run.id, 'hide')).toEqual(['failed', 'retries_exhausted']);
    expect(await runCompleted(run.id)).toBe(true);
    expect(graph.state(seeded.commentId)).toBe('visible');
  });

  it('a later evaluation retries an automated hide that failed', async () => {
    const first = await start([HIDE]);
    graph.failNext(10);
    await queue.drain();
    expect(await outcome(first.id, 'hide')).toEqual(['failed', 'missing_permission']);
    const second = await start([HIDE]);
    await queue.drain();
    expect(await outcome(second.id, 'hide')).toEqual(['succeeded', null]);
    expect(graph.state(seeded.commentId)).toBe('hidden');
    expect((await actionsOf(seeded.id)).map((a) => a.status).sort()).toEqual(['applied', 'failed']);
  });

  it('ban on instagram reaching execution -> not_supported / unsupported', async () => {
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop.official' });
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
    const ig: ConnectionScope = { ...scope, connectionId: r.rows[0]!.id };
    await creds.put(ig, 'access_token', new Secret(pageToken), null);
    const c = graph.addIgComment(igUserId, { text: 'spam here', createdAtMs: nowMs - 60_000 });
    const id = await ingestComment(ig, 'instagram', {
      sourceExternalId: c.mediaId,
      commentExternalId: c.commentId,
    });

    const run = await start([BAN, HIDE], { s: ig, commentId: id });
    await queue.drain();
    expect(await outcome(run.id, 'ban')).toEqual(['not_supported', 'unsupported']);
    expect(await outcome(run.id, 'hide')).toEqual(['succeeded', null]);
    expect(graph.igState(c.commentId)).toBe('hidden');
    expect((await actionsOf(id)).map((a) => a.kind)).toEqual(['hide']);
  });

  it('private reply after window -> not_applicable / private_reply_window_closed', async () => {
    const old = await addFbComment({ createdAtMs: nowMs - 8 * DAY });
    const run = await start([DM], { commentId: old.id });
    await queue.drain();
    expect(await outcome(run.id, 'private_reply')).toEqual([
      'not_applicable',
      'private_reply_window_closed',
    ]);
    expect(graph.privateReplies(old.commentId)).toEqual([]);
  });

  it('own-account comment (our own auto-reply re-ingested) -> all steps skipped own_account_comment, no platform calls', async () => {
    const own = await addFbComment({ authorId: pageId, message: 'Hi there, thanks!' });
    expect((await store.load(t, own.id))?.isOwnAccount).toBe(true);
    const calls = graph.calls().length;
    const run = await start([FLAG, DM, REPLY, HIDE, BAN, DELETE], { commentId: own.id });
    await queue.drain();
    for (const s of run.steps)
      expect(await outcome(run.id, s.type)).toEqual(['skipped', 'own_account_comment']);
    expect(graph.calls().length).toBe(calls);
    expect(await actionsOf(own.id)).toEqual([]);
    expect(await reviewItems(own.id)).toEqual([]);
    expect(await runCompleted(run.id)).toBe(true);
  });

  it('auto_reply skipped with reply_thread_limit on a follow-up in the same thread', async () => {
    const first = await start([REPLY]);
    await queue.drain();
    expect(await outcome(first.id, 'auto_reply')).toEqual(['succeeded', null]);
    // The commenter answers "thanks!" under our reply.
    const followUp = await addFbComment({
      postId: seeded.postId,
      parentId: seeded.commentId,
      message: 'thanks!',
    });
    const second = await start([REPLY], { commentId: followUp.id });
    await queue.drain();
    expect(await outcome(second.id, 'auto_reply')).toEqual(['skipped', 'reply_thread_limit']);
    expect(ourReplies(seeded)).toHaveLength(1);
    expect(await actionsOf(followUp.id)).toEqual([]);
  });

  it('advance adopts an unlinked action with its own key after a crash', async () => {
    const run = await start([HIDE]);
    // The previous advance asked for the action, then crashed before linking it.
    const r = await actions.request({
      scope: t,
      commentId: seeded.id,
      kind: 'hide',
      actor: { type: 'rule', ruleId: t.ruleId },
      requestKey: `auto:${seeded.id}:hide`,
    });
    expect(r.status).toBe('accepted');
    const hides = () =>
      graph.calls().filter((c) => c.method === 'POST' && c.path.endsWith(seeded.commentId));
    await queue.drain();
    expect(await outcome(run.id, 'hide')).toEqual(['succeeded', null]);
    expect((await stepOf(run.id, 'hide')).moderation_action_id).toBe(
      r.status === 'accepted' ? r.action.id : null,
    );
    expect(await actionsOf(seeded.id)).toHaveLength(1);
    expect(hides()).toHaveLength(1);
    expect(graph.state(seeded.commentId)).toBe('hidden');
  });

  it('a step whose request went out is linked even if the precheck would now skip it', async () => {
    const run = await start([HIDE]);
    const request = actions.request.bind(actions);
    // A person unhides the comment while the hide request is on its way.
    vi.spyOn(actions, 'request').mockImplementationOnce(async (i) => {
      const r = await request(i);
      await ctx.c.query(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
           actor_type, actor_user_id, request_key, status)
         VALUES ($1, $2, $3, $4, 'unhide', 'user', $5, $6, 'pending')`,
        [t.organizationId, t.brandId, t.connectionId, seeded.id, t.userId, `ui-${randomUUID()}`],
      );
      return r;
    });
    await queue.drain(ACTION_RUN_ADVANCE_JOB.type);
    const step = await stepOf(run.id, 'hide');
    const [hide] = await pool
      .query<{
        id: string;
      }>(`SELECT id FROM moderation_action WHERE comment_id = $1 AND kind = 'hide'`, [seeded.id])
      .then((r) => r.rows);
    expect(step.moderation_action_id).toBe(hide!.id);
    expect(step.reason_code).not.toBe('moderator_override');
  });

  it('edited comment after undo: hide skipped moderator_override', async () => {
    const first = await start([HIDE]);
    await queue.drain();
    const stepId = first.steps[0]!.id;
    expect(graph.state(seeded.commentId)).toBe('hidden');
    // Undo from the log: a user unhide, and the step marked undone.
    const u = await actions.request({
      scope: t,
      commentId: seeded.id,
      kind: 'unhide',
      actor: { type: 'user', userId: t.userId },
      requestKey: `undo:${stepId}`,
    });
    if (u.status !== 'accepted') throw new Error('unhide not accepted');
    await withTransaction(pool, (tx) => runs.markUndone(tx, scope, stepId, t.userId, u.action.id));
    await queue.drain();
    expect(graph.state(seeded.commentId)).toBe('visible');

    graph.editComment(seeded.commentId, 'spam here, edited');
    const second = await start([HIDE]);
    await queue.drain();
    expect(await outcome(second.id, 'hide')).toEqual(['skipped', 'moderator_override']);
    expect(graph.state(seeded.commentId)).toBe('visible');
    expect((await actionsOf(seeded.id)).map((a) => a.kind)).toEqual(['hide', 'unhide']);
  });

  it('user unhide in the comments UI blocks automated re-hide on re-evaluation', async () => {
    await start([HIDE]);
    await queue.drain();
    const u = await actions.request({
      scope: t,
      commentId: seeded.id,
      kind: 'unhide',
      actor: { type: 'user', userId: t.userId },
      requestKey: `ui-${randomUUID()}`,
    });
    expect(u.status).toBe('accepted');
    await queue.drain();
    const again = await start([HIDE]);
    await queue.drain();
    expect(await outcome(again.id, 'hide')).toEqual(['skipped', 'moderator_override']);
    expect(graph.state(seeded.commentId)).toBe('visible');
  });

  it('missing pages_messaging -> private_reply failed / missing_permission without a platform call', async () => {
    grantedOverride.set(scope.connectionId, ['pages_manage_engagement', 'pages_read_engagement']);
    const calls = graph.calls().length;
    const run = await start([DM]);
    await queue.drain();
    expect(await outcome(run.id, 'private_reply')).toEqual(['failed', 'missing_permission']);
    expect(graph.calls().length).toBe(calls);
    expect(await actionsOf(seeded.id)).toEqual([]);
  });

  it('dry run writes simulated steps with previews and makes no platform call, action row or review item', async () => {
    const calls = graph.calls().length;
    const author = (await store.load(t, seeded.id))!.authorName!;
    const run = await start([FLAG, DM, REPLY], { dryRun: true });
    const steps = (
      await pool.query<{
        step_type: string;
        status: string;
        reason_code: string;
        preview_text: string | null;
      }>(
        `SELECT step_type, status, reason_code, preview_text FROM action_run_step
          WHERE run_id = $1 ORDER BY position`,
        [run.id],
      )
    ).rows;
    expect(steps).toEqual([
      {
        step_type: 'flag_for_review',
        status: 'simulated',
        reason_code: 'would_run',
        preview_text: null,
      },
      {
        step_type: 'private_reply',
        status: 'simulated',
        reason_code: 'would_run',
        preview_text: `Hello ${author.split(' ')[0]}, check your inbox`,
      },
      {
        step_type: 'auto_reply',
        status: 'simulated',
        reason_code: 'would_run',
        preview_text: `Hi ${author}, thanks!`,
      },
    ]);
    expect(await runCompleted(run.id)).toBe(true);
    await queue.drain();
    expect(graph.calls().length).toBe(calls);
    expect(await actionsOf(seeded.id)).toEqual([]);
    expect(await reviewItems(seeded.id)).toEqual([]);
    expect(queue.requests).toEqual([]);
  });

  it('dry run predicts precheck and eligibility codes', async () => {
    const old = await addFbComment({ createdAtMs: nowMs - 8 * DAY });
    const run = await start([DM, HIDE], { commentId: old.id, dryRun: true });
    expect(await outcome(run.id, 'private_reply')).toEqual([
      'simulated',
      'private_reply_window_closed',
    ]);
    expect(await outcome(run.id, 'hide')).toEqual(['simulated', 'would_run']);
    expect(await runner.planner.simulate(scope, old.id, [HIDE, DM])).toEqual([
      {
        type: 'private_reply',
        status: 'not_applicable',
        reason: 'private_reply_window_closed',
        previewText: expect.stringMatching(/^Hello /),
      },
      { type: 'hide', status: 'succeeded', reason: 'would_run', previewText: null },
    ]);
    expect(await actionsOf(old.id)).toEqual([]);
  });

  it('template with hostile author name posts the fallback text', async () => {
    await ctx.c.query(
      `UPDATE author SET display_name = 'Free iPhone at scam.io'
        WHERE id = (SELECT author_id FROM comment WHERE id = $1)`,
      [seeded.id],
    );
    const run = await start([REPLY]);
    await queue.drain();
    expect(await outcome(run.id, 'auto_reply')).toEqual(['succeeded', null]);
    expect(ourReplies(seeded).map((r) => r.message)).toEqual(['Hi there, thanks!']);
    const logs = logLines.join('\n');
    expect(logs).not.toContain('scam.io');
    expect(logs).not.toContain('Hi there');
  });

  it('advance for a run of another connection is a no-op', async () => {
    const run = await start([HIDE]);
    const other = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'facebook', $3) RETURNING id`,
      [t.organizationId, t.brandId, `other-${randomUUID().slice(0, 8)}`],
    );
    const foreign: ConnectionScope = { ...scope, connectionId: other.rows[0]!.id };
    expect(await runner.advance(foreign, run.id)).toEqual({ settled: 0, completed: false });
    expect(
      await advanceJob.handle(jobCtx(foreign, 'facebook', ACTION_RUN_ADVANCE_JOB.type), {
        runId: run.id,
        settled: 0,
      }),
    ).toMatchObject({ settled: 0, completed: false });
    expect(await outcome(run.id, 'hide')).toEqual(['pending', null]);
    expect(await actionsOf(seeded.id)).toEqual([]);
  });

  it('the outcome observer ignores actions that belong to no step', async () => {
    const r = await actions.request({
      scope: t,
      commentId: seeded.id,
      kind: 'hide',
      actor: { type: 'rule', ruleId: t.ruleId },
      requestKey: `rule-eval:${randomUUID()}`,
    });
    expect(r.status).toBe('accepted');
    await queue.drain();
    expect(queue.requests.filter((q) => q.req.type === ACTION_RUN_ADVANCE_JOB.type)).toEqual([]);
  });
});

describe('ACTION_RUN_ADVANCE_JOB', () => {
  it('accepts settled up to 7 and an optional cause in the ref', () => {
    const runId = randomUUID();
    const p = ACTION_RUN_ADVANCE_JOB.payload.parse({ runId, settled: 7, cause: 'x:applied' });
    expect(ACTION_RUN_ADVANCE_JOB.externalRef(p)).toBe(`run:${runId}:7:x:applied`);
    expect(ACTION_RUN_ADVANCE_JOB.externalRef({ runId, settled: 0 })).toBe(`run:${runId}:0:`);
    expect(ACTION_RUN_ADVANCE_JOB.payload.safeParse({ runId, settled: 8 }).success).toBe(false);
    expect(
      ACTION_RUN_ADVANCE_JOB.payload.safeParse({ runId, settled: 1, cause: 'a b' }).success,
    ).toBe(false);
  });
});

describe('failures that need the transaction to stay usable', () => {
  it('a SQL error while flagging fails the step, and the run still completes', async () => {
    failNextReviewSql = true;
    const run = await start([FLAG, HIDE]);
    await expect(runner.advance(scope, run.id)).resolves.toBeDefined();
    await queue.drain();
    expect(await outcome(run.id, 'flag_for_review')).toEqual(['failed', 'internal_error']);
    expect(await outcome(run.id, 'hide')).toEqual(['succeeded', null]);
    expect(await runCompleted(run.id)).toBe(true);
  });

  it('concurrent advances finish on a pool no larger than the number of locks held', async () => {
    const small = createPool(ctx.db.url, {
      applicationName: 'actions-runner-small',
      max: 2,
      onIdleError: () => {},
    });
    try {
      const smallStore = new PgCommentStore(small);
      const smallRunner = new ActionRunner({
        pool: small,
        runs: new PgActionRunStore(small),
        review,
        comments: smallStore,
        actions: new ModerationActions({
          pool: small,
          store: smallStore,
          producer: queue,
          capabilities: (p) => registry.get(p)?.capabilities,
          clock,
          log: quiet,
        }),
        connection: async (s) => {
          const caps = registry.get('facebook')!.capabilities;
          return {
            connectionId: s.connectionId,
            platform: 'facebook',
            caps,
            grantedScopes: caps.defaultScopes,
          };
        },
        brandName: async () => 'Shop',
        producer: queue,
        clock,
        log: quiet,
      });
      const started: RunRow[] = [];
      for (let i = 0; i < 4; i++) {
        const c = await addFbComment();
        started.push(await start([HIDE, REPLY], { commentId: c.id }));
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('advance deadlocked')), 20_000).unref(),
      );
      await Promise.race([
        Promise.all(started.map((r) => smallRunner.advance(scope, r.id))),
        timeout,
      ]);
    } finally {
      await small.end();
    }
  }, 30_000);
});
