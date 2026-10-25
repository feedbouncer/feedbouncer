// Threads end to end with the worker's own job registry (buildJobRegistry): the scheduler wakes
// the poll job, the poll ingests replies from FakeThreads, rules decide, the action runner
// plans steps and the execute job calls the fake. Jobs are driven from the job ledger, one
// queued row at a time, with the real runner (leases, retries, deferrals, dead letters).
// It lives in the worker because rules and actions depend on comments, so a suite there
// could not import them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DelayedError, UnrecoverableError } from 'bullmq';
import {
  PgActionRunStore,
  PgReviewQueue,
  deriveOutcome,
  undoStep,
  type ActionStep,
} from '@feedbouncer/actions';
import { loadClassifierConfig } from '@feedbouncer/classifier';
import {
  ModerationActions,
  NotifyingConnectionDirectory,
  PgCommentStore,
  PgThreadsPolling,
  ThreadsPollScheduler,
  threadsWakeSink,
} from '@feedbouncer/comments';
import { createThreadsConnector, type ThreadsConfig } from '@feedbouncer/connector-threads';
import { FakeThreads } from '@feedbouncer/connector-threads/testing';
import {
  ConnectorRegistry,
  ConnectorRuntime,
  MemoryRefreshLock,
  PgConnectionDirectory,
  PgCredentialVault,
  RateBudget,
  TokenManager,
  createSafeHttp,
  type Clock,
  type OAuthContext,
} from '@feedbouncer/connectors';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  JobMetrics,
  JobProducer,
  PgJobLedger,
  createJobProcessor,
  loadJobsConfig,
  policyResolver,
  type QueueSet,
} from '@feedbouncer/jobs';
import { loadPolicyConfig } from '@feedbouncer/policies';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { buildJobRegistry } from './registries.js';

const APP = { appId: '1234567890', appSecret: 'threads-test-SECRET-0123456789' };
const MIN = 60_000;
const log = createLogger('threads-moderation-test', 'error', () => {});
const NO_MANAGE = ['threads_basic', 'threads_read_replies', 'threads_content_publish'];

let t = Date.UTC(2026, 9, 24, 12, 0, 0);
const clock: Clock = { now: () => t };
const advance = (ms: number) => void (t += ms);

const fake = new FakeThreads({ ...APP, now: () => new Date(t) });
const cfg: ThreadsConfig = {
  appId: APP.appId,
  appSecret: new Secret(APP.appSecret),
  webhookVerifyToken: null,
  pollIntervalSec: 600,
  discoveryIntervalSec: 900,
};
const connector = createThreadsConnector(cfg, { clock });
const reconnectNotices: string[] = [];

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
let creds: CredentialStore;
let runtime: ConnectorRuntime;
let producer: JobProducer;
let scheduler: ThreadsPollScheduler;
let polling: PgThreadsPolling;
let actions: ModerationActions;
let jobsConfig: ReturnType<typeof loadJobsConfig>;
let jobs: ReturnType<typeof buildJobRegistry>;
let ledger: PgJobLedger;
let n = 0;

const http = () =>
  createSafeHttp({ allowedHosts: connector.capabilities.apiHosts, fetch: fake.fetch });
const oauth = (): OAuthContext => ({
  http: http(),
  signal: AbortSignal.timeout(15_000),
  redirectUri: 'https://app.test/cb',
});

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'threads-moderation', onIdleError: () => {} });
  const registry = new ConnectorRegistry();
  registry.register(connector);
  creds = new CredentialStore(pool, testKeyring(['k1']));
  const directory = new NotifyingConnectionDirectory(
    new PgConnectionDirectory(pool),
    {
      connectionNeedsReconnect: async (s) => {
        reconnectNotices.push(s.connectionId);
      },
    },
    log,
  );
  const vault = new PgCredentialVault(creds, pool, log);
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log,
    oauthContext: oauth,
  });
  const budget = new RateBudget(() => ({
    consume: async () => ({}),
    reward: async () => ({}),
    penalty: async () => ({}),
    block: async () => ({}),
    get: async () => null,
  }));
  runtime = new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget,
    clock,
    log,
    http,
  });
  const store = new PgCommentStore(pool);
  polling = new PgThreadsPolling(pool);
  jobsConfig = loadJobsConfig({});
  ledger = new PgJobLedger(pool);
  jobs = buildJobRegistry({
    runtime,
    directory,
    store,
    pool,
    slotsPool: pool,
    classifier: loadClassifierConfig({}),
    policy: loadPolicyConfig({}),
    clock,
    log,
    ingestObserver: { onIngested: () => {} },
    producer: { enqueue: (input) => producer.enqueue(input) },
    capabilities: (p) => registry.get(p)?.capabilities,
    threads: { settings: cfg },
  });
  producer = new JobProducer({
    ledger,
    jobs,
    connectors: registry,
    // Delivery is the test's drain loop, not Redis.
    queues: { add: async () => {}, nameFor: () => 'threads' } as unknown as QueueSet,
    metrics: new JobMetrics(log),
    dedupWindowMs: jobsConfig.dedupWindowMs,
  });
  scheduler = new ThreadsPollScheduler({ polling, producer, clock, log });
  actions = new ModerationActions({
    pool,
    store,
    producer,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock,
    log,
  });
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

/** Runs the queued jobs of one organization until none is left; a job that must wait runs once per call. */
async function drain(orgId: string, o: { except?: readonly string[] } = {}): Promise<string[]> {
  const ran: string[] = [];
  const parked = new Set<string>();
  for (let round = 0; round < 40; round++) {
    // Retries and deferrals wait in Redis in production; here the wait is over.
    await pool.query(
      `UPDATE job_ledger SET next_run_at = NULL WHERE state = 'queued' AND organization_id = $1`,
      [orgId],
    );
    const { rows } = await pool.query<{ id: string; job_type: string }>(
      `SELECT id, job_type FROM job_ledger
        WHERE state = 'queued' AND organization_id = $1 AND platform = 'threads'
        ORDER BY created_at, id`,
      [orgId],
    );
    const todo = rows.filter((r) => !parked.has(r.id) && !o.except?.includes(r.job_type));
    if (todo.length === 0) return ran;
    for (const r of todo) {
      const process = createJobProcessor({
        platform: 'threads',
        lane: jobs.laneOf()(r.job_type),
        laneOf: jobs.laneOf(),
        ledger,
        jobs,
        policyFor: policyResolver(jobsConfig, jobs),
        dlqRetentionMs: jobsConfig.dlqRetentionMs,
        workerId: 'threads-moderation',
        log,
        metrics: new JobMetrics(log),
        now: clock.now,
      });
      try {
        await process({
          id: r.id,
          name: r.job_type,
          data: { v: 1, ledgerId: r.id },
          moveToDelayed: async () => {},
        });
      } catch (err) {
        if (!(err instanceof DelayedError) && !(err instanceof UnrecoverableError)) throw err;
        parked.add(r.id);
      }
      ran.push(r.job_type);
    }
  }
  throw new Error('jobs did not settle');
}

interface World {
  t: Tenant;
  scope: ConnectionScope;
  userId: string;
  postId: string;
  accessToken: string;
}

/** A tenant with an active Threads connection and one post, its backfill pass done. */
async function world(label: string, o: { scopes?: string[] } = {}): Promise<World> {
  const tenant = await seedTenant(db.c, `thr-mod-${label}-${++n}`);
  await db.c.query('DELETE FROM connection WHERE id = $1', [tenant.connectionId]);
  await db.c.query('UPDATE rule SET archived_at = now(), enabled = false WHERE brand_id = $1', [
    tenant.brandId,
  ]);
  const { userId, authCode } = fake.addUser({
    username: `shop${n}`,
    ...(o.scopes && { scopes: o.scopes }),
  });
  const { tokens: tk } = await connector.exchangeCode(
    { code: new Secret(authCode), codeVerifier: new Secret('v') },
    oauth(),
  );
  const r = await db.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, granted_scopes, review_mode)
     VALUES ($1, $2, 'threads', $3, 'active', $4::text[], 'legacy') RETURNING id`,
    [tenant.organizationId, tenant.brandId, userId, tk.scopes],
  );
  const scope: ConnectionScope = {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    connectionId: r.rows[0]!.id,
  };
  await creds.put(scope, 'access_token', tk.accessToken, tk.accessTokenExpiresAt);
  await creds.put(scope, 'refresh_token', tk.refreshToken!, tk.refreshTokenExpiresAt);
  const { postId } = fake.addPost(userId, { at: new Date(t - 60 * MIN) });
  const w = { t: tenant, scope, userId, postId, accessToken: tk.accessToken.reveal() };
  await pump(w);
  return w;
}

/** One poll interval later: the scheduler wakes the connection and the queued jobs run. */
async function pump(w: World, o: { except?: readonly string[] } = {}): Promise<string[]> {
  advance(11 * MIN);
  await scheduler.tick();
  return drain(w.t.organizationId, o);
}

let seq = 0;
/** A reply posted just before the next poll. */
const reply = (w: World, text: string, parentId = w.postId) =>
  fake.addReply(parentId, {
    text,
    at: new Date(t + 1000),
    username: `visitor${++seq}`,
  }).replyId;

async function addRule(
  w: World,
  conditions: object,
  steps: ActionStep[],
  priority = 10,
): Promise<string> {
  const r = await db.c.query<{ id: string }>(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode, priority)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, 'enforce', $7) RETURNING id`,
    [
      w.t.organizationId,
      w.t.brandId,
      `rule ${priority}`,
      JSON.stringify(conditions),
      deriveOutcome(steps),
      JSON.stringify(steps),
      priority,
    ],
  );
  return r.rows[0]!.id;
}
const kw = (...terms: string[]) => ({ type: 'keyword', terms });
const HIDE: ActionStep[] = [{ type: 'hide' }];
const REPLY: ActionStep[] = [{ type: 'auto_reply', template: 'Thanks for the feedback.' }];

const actionRows = async (w: World, externalId: string) =>
  (
    await pool.query<{
      id: string;
      kind: string;
      status: string;
      outcome_code: string | null;
      rule_id: string | null;
      deferred_code: string | null;
      deferred_until: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT m.id, m.kind, m.status, m.outcome_code, m.rule_id, m.deferred_code, m.deferred_until, m.completed_at
         FROM moderation_action m JOIN comment c ON c.id = m.comment_id
        WHERE m.connection_id = $1 AND c.external_id = $2 ORDER BY m.created_at, m.kind`,
      [w.scope.connectionId, externalId],
    )
  ).rows;
const stepRows = async (w: World, externalId: string) =>
  (
    await pool.query<{
      id: string;
      step_type: string;
      status: string;
      reason_code: string | null;
      review_item_id: string | null;
      undone_at: Date | null;
    }>(
      `SELECT s.id, s.step_type, s.status, s.reason_code, s.review_item_id, s.undone_at
         FROM action_run_step s JOIN action_run r ON r.id = s.run_id
         JOIN comment c ON c.id = r.comment_id
        WHERE c.connection_id = $1 AND c.external_id = $2 ORDER BY r.created_at, s.position`,
      [w.scope.connectionId, externalId],
    )
  ).rows;
const commentRow = async (w: World, externalId: string) =>
  (
    await pool.query<{ id: string; platform_state: string; is_own_account: boolean }>(
      'SELECT id, platform_state, is_own_account FROM comment WHERE connection_id = $1 AND external_id = $2',
      [w.scope.connectionId, externalId],
    )
  ).rows[0];
const evaluations = async (commentId: string) =>
  (
    await pool.query<{ status: string; skip_reason: string | null }>(
      'SELECT status, skip_reason FROM rule_evaluation WHERE comment_id = $1',
      [commentId],
    )
  ).rows;
const reviewItems = async (commentId: string) =>
  (
    await pool.query<{ status: string }>('SELECT status FROM review_item WHERE comment_id = $1', [
      commentId,
    ])
  ).rows;
/** FakeThreads is shared by every test; calls are told apart by the reply (manage_reply) or the account (publish). */
const callsOn = (endpoint: 'manageReply' | 'publish', id: string) =>
  fake.calls(endpoint).filter((c) => c.id === id);

describe('threads moderation end to end', () => {
  it('rule hide + reply on a top-level reply: hides once, replies once, audit has rule, action, result, time', async () => {
    const w = await world('hide-reply');
    const rule = await addRule(w, kw('spam'), [...HIDE, ...REPLY]);
    const id = reply(w, 'buy spam here');
    await pump(w);

    expect(fake.hideStatus(id)).toBe('HIDDEN');
    expect(callsOn('manageReply', id)).toHaveLength(1);
    expect(callsOn('publish', w.userId)).toHaveLength(1);
    expect(fake.repliesBy(w.userId).map((r) => [r.replyToId, r.text])).toEqual([
      [id, 'Thanks for the feedback.'],
    ]);

    const rows = await actionRows(w, id);
    expect(rows.map((a) => [a.kind, a.status, a.rule_id])).toEqual([
      ['public_reply', 'applied', rule],
      ['hide', 'applied', rule],
    ]);
    expect((await commentRow(w, id))?.platform_state).toBe('hidden');
    const audit = await pool.query<{ details: Record<string, unknown>; created_at: Date }>(
      `SELECT details, created_at FROM audit_event
        WHERE organization_id = $1 AND action = 'comment.moderated' ORDER BY sequence`,
      [w.t.organizationId],
    );
    expect(audit.rows.map((a) => [a.details.kind, a.details.status]).sort()).toEqual([
      ['hide', 'applied'],
      ['public_reply', 'applied'],
    ]);
    expect(audit.rows.map((a) => a.details.actionId).sort()).toEqual(rows.map((a) => a.id).sort());
    expect(audit.rows.every((a) => a.created_at instanceof Date)).toBe(true);
    expect((await stepRows(w, id)).map((s) => [s.step_type, s.status])).toEqual([
      ['auto_reply', 'succeeded'],
      ['hide', 'succeeded'],
    ]);
  });

  it('same reply delivered by webhook twice and by poll → one hide call, one publish', async () => {
    const w = await world('dedupe');
    await addRule(w, kw('spam'), [...HIDE, ...REPLY]);
    const id = reply(w, 'spam spam');
    const wake = threadsWakeSink(polling, clock);
    const event = {
      type: 'comment.created' as const,
      externalAccountId: w.userId,
      ref: { sourceExternalId: w.postId, externalId: id },
      occurredAt: new Date(t),
    };
    await wake(w.scope, event);
    await wake(w.scope, event);
    await pump(w);
    // A later interval reads the same reply again.
    await pump(w);

    expect(callsOn('manageReply', id)).toHaveLength(1);
    expect(callsOn('publish', w.userId)).toHaveLength(1);
    expect(await actionRows(w, id)).toHaveLength(2);
  });

  it('already hidden on Threads → hide step skipped/already_hidden, no API call', async () => {
    const w = await world('already-hidden');
    await addRule(w, kw('spam'), HIDE);
    const id = reply(w, 'spam');
    const client = await runtime.connect(w.scope);
    await client.act({ action: 'hide', target: { sourceExternalId: w.postId, externalId: id } });
    expect(callsOn('manageReply', id)).toHaveLength(1);
    await pump(w);

    expect(callsOn('manageReply', id)).toHaveLength(1);
    expect((await commentRow(w, id))?.platform_state).toBe('hidden');
    expect(await stepRows(w, id)).toEqual([
      expect.objectContaining({
        step_type: 'hide',
        status: 'skipped',
        reason_code: 'already_hidden',
      }),
    ]);
  });

  it('unhide from the action-log undo → manage_reply hide=false, step undone', async () => {
    const w = await world('undo');
    await addRule(w, kw('spam'), HIDE);
    const id = reply(w, 'spam');
    await pump(w);
    expect(fake.hideStatus(id)).toBe('HIDDEN');
    const [step] = await stepRows(w, id);

    const result = await undoStep(
      {
        pool,
        runs: new PgActionRunStore(pool),
        review: new PgReviewQueue(pool),
        actions,
        audit: async () => {},
      },
      w.scope,
      step!.id,
      w.t.userId,
    );
    expect(result.status).toBe('accepted');
    await drain(w.t.organizationId);

    expect(fake.hideStatus(id)).toBe('UNHUSHED');
    expect(callsOn('manageReply', id).map((c) => c.form.hide)).toEqual(['true', 'false']);
    expect((await stepRows(w, id))[0]?.undone_at).not.toBeNull();
    expect((await commentRow(w, id))?.platform_state).toBe('visible');
  });

  it('rule hide on a nested reply → no manage_reply, step not_supported, review item hide_nested_reply_unsupported', async () => {
    const w = await world('nested');
    await addRule(w, kw('spam'), HIDE);
    const top = reply(w, 'a fine question');
    const nested = reply(w, 'spam', top);
    await pump(w);

    expect(callsOn('manageReply', nested)).toHaveLength(0);
    expect(callsOn('manageReply', top)).toHaveLength(0);
    const [step] = await stepRows(w, nested);
    expect(step).toMatchObject({ step_type: 'hide', status: 'not_supported' });
    expect(step!.reason_code).toBe('hide_nested_reply_unsupported');
    expect(await reviewItems((await commentRow(w, nested))!.id)).toEqual([{ status: 'open' }]);
    expect(fake.hideStatus(nested)).toBe('NOT_HUSHED');
  });

  it('own published reply is never evaluated and triggers no reply', async () => {
    const w = await world('own-reply');
    // The template itself matches the rule: evaluating our reply would reply to it again.
    await addRule(w, kw('spam'), [{ type: 'auto_reply', template: 'No spam please.' }]);
    const id = reply(w, 'spam');
    await pump(w);
    expect(callsOn('publish', w.userId)).toHaveLength(1);
    const [own] = fake.repliesBy(w.userId);

    await pump(w);
    await pump(w);

    const stored = await commentRow(w, own!.id);
    expect(stored?.is_own_account).toBe(true);
    expect(await evaluations(stored!.id)).toEqual([
      { status: 'skipped', skip_reason: 'own_account' },
    ]);
    expect(callsOn('publish', w.userId)).toHaveLength(1);
    expect(await actionRows(w, own!.id)).toEqual([]);
    expect(await actionRows(w, id)).toHaveLength(1);
  });

  it('reply quota exhausted → action pending with deferred_code reply_quota_exhausted; hide on another reply in the same pass still applies; after quota frees, reply publishes once and deferral clears', async () => {
    const w = await world('quota');
    await addRule(w, kw('spam'), REPLY, 10);
    await addRule(w, kw('scam'), HIDE, 20);
    fake.setReplyQuotaUsage(w.userId, 1000);
    const a = reply(w, 'spam');
    const b = reply(w, 'scam');
    await pump(w);

    expect(fake.hideStatus(b)).toBe('HIDDEN');
    expect(callsOn('publish', w.userId)).toHaveLength(0);
    const [waiting] = await actionRows(w, a);
    expect(waiting).toMatchObject({
      kind: 'public_reply',
      status: 'pending',
      deferred_code: 'reply_quota_exhausted',
    });
    expect(waiting!.deferred_until).toBeInstanceOf(Date);

    fake.setReplyQuotaUsage(w.userId, 0);
    await drain(w.t.organizationId);

    expect(callsOn('publish', w.userId)).toHaveLength(1);
    const [done] = await actionRows(w, a);
    expect(done).toMatchObject({ status: 'applied', deferred_code: null, deferred_until: null });
    expect(fake.repliesBy(w.userId)).toHaveLength(1);
  });

  it('revoked token pauses and reconnect resumes without duplicates', async () => {
    const w = await world('revoked');
    await addRule(w, kw('spam'), HIDE);
    const first = reply(w, 'spam one');
    // Ingested and decided, but the hide has not run yet.
    await pump(w, { except: ['moderation_execute'] });
    expect((await actionRows(w, first))[0]?.status).toBe('pending');

    fake.revokeToken(w.accessToken);
    const noticesBefore = reconnectNotices.length;
    await drain(w.t.organizationId);
    const row = await pool.query<{ status: string }>(
      'SELECT status FROM connection WHERE id = $1',
      [w.scope.connectionId],
    );
    expect(row.rows[0]?.status).toBe('reconnect_required');
    expect(reconnectNotices.length - noticesBefore).toBe(1);
    expect((await actionRows(w, first))[0]?.status).toBe('pending');
    expect(fake.hideStatus(first)).toBe('NOT_HUSHED');

    // Paused: nothing is polled while the connection needs reconnecting.
    const missed = reply(w, 'spam two');
    expect((await pump(w)).length).toBe(0);
    expect(reconnectNotices.length - noticesBefore).toBe(1);

    const { tokens: tk } = await connector.exchangeCode(
      { code: new Secret(fake.newAuthCode(w.userId)), codeVerifier: new Secret('v') },
      oauth(),
    );
    await creds.put(w.scope, 'access_token', tk.accessToken, tk.accessTokenExpiresAt);
    await creds.put(w.scope, 'refresh_token', tk.refreshToken!, tk.refreshTokenExpiresAt);
    await pool.query(
      `UPDATE connection SET status = 'active', status_reason = NULL, missing_scopes = '{}' WHERE id = $1`,
      [w.scope.connectionId],
    );
    await producer.replay({
      organizationId: w.scope.organizationId,
      connectionId: w.scope.connectionId,
      reason: 'needs_reconnection',
      limit: 1000,
    });
    await drain(w.t.organizationId);
    expect(fake.hideStatus(first)).toBe('HIDDEN');
    expect((await actionRows(w, first))[0]?.status).toBe('applied');

    await pump(w);
    expect(fake.hideStatus(missed)).toBe('HIDDEN');
    // Every call made with the new token: one hide for each reply, none repeated.
    const fresh = tk.accessToken.reveal();
    const applied = (id: string) => callsOn('manageReply', id).filter((c) => c.bearer === fresh);
    expect(applied(first)).toHaveLength(1);
    expect(applied(missed)).toHaveLength(1);
  });

  it('declined threads_manage_replies: replies still ingested; hide step not_supported with missing_permission; flagged for review', async () => {
    const w = await world('declined', { scopes: NO_MANAGE });
    await addRule(w, kw('spam'), HIDE);
    const id = reply(w, 'spam');
    await pump(w);

    expect(await commentRow(w, id)).toBeDefined();
    expect(callsOn('manageReply', id)).toHaveLength(0);
    const [step] = await stepRows(w, id);
    expect(step).toMatchObject({
      step_type: 'hide',
      status: 'failed',
      reason_code: 'missing_permission',
    });
    expect(await reviewItems((await commentRow(w, id))!.id)).toEqual([{ status: 'open' }]);
  });

  it('reply deleted before the hide runs → noop comment_gone, comment marked deleted', async () => {
    const w = await world('deleted');
    await addRule(w, kw('spam'), HIDE);
    const id = reply(w, 'spam');
    await pump(w, { except: ['moderation_execute'] });
    fake.deleteReply(id);
    await drain(w.t.organizationId);

    expect(await actionRows(w, id)).toEqual([
      expect.objectContaining({ kind: 'hide', status: 'noop', outcome_code: 'comment_gone' }),
    ]);
    expect((await commentRow(w, id))?.platform_state).toBe('deleted');
  });

  it('transient manage_reply failure 8 times → action failed after the 8th attempt with the mapped reason shown', async () => {
    const w = await world('transient');
    await addRule(w, kw('spam'), HIDE);
    const id = reply(w, 'spam');
    fake.failNext('manageReply', { httpStatus: 503, times: 8 });
    await pump(w);
    for (let attempt = 2; attempt <= 8; attempt++) {
      expect((await actionRows(w, id))[0]?.status).toBe('pending');
      await drain(w.t.organizationId);
    }

    expect(callsOn('manageReply', id)).toHaveLength(8);
    const [action] = await actionRows(w, id);
    expect(action).toMatchObject({ status: 'failed' });
    // The last attempt records the mapped Threads code, so the owner sees why it failed.
    expect(action!.outcome_code).toBe('threads_unavailable');
    expect((await stepRows(w, id))[0]).toMatchObject({ status: 'failed' });
    expect(fake.hideStatus(id)).toBe('NOT_HUSHED');
  });

  it('empty-text reply evaluated without error; keyword rule does not match; emoji rule matches 🔥🔥🔥', async () => {
    const w = await world('empty-emoji');
    await addRule(w, kw('spam'), HIDE, 10);
    await addRule(w, { type: 'emoji', emoji: ['🔥'], maxCount: 2 }, HIDE, 20);
    const empty = reply(w, '');
    const fire = reply(w, '🔥🔥🔥');
    await pump(w);

    const stored = await commentRow(w, empty);
    expect(stored).toBeDefined();
    expect(await evaluations(stored!.id)).toEqual([{ status: 'no_match', skip_reason: null }]);
    expect(await actionRows(w, empty)).toEqual([]);
    expect(fake.hideStatus(fire)).toBe('HIDDEN');
    expect(callsOn('manageReply', empty)).toHaveLength(0);
    expect(callsOn('manageReply', fire)).toHaveLength(1);
  });
});
