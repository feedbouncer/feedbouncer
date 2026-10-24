// TikTok organic and ad connections end to end. The API serves the connect flow,
// rules, review mode, comments and disconnect; the worker side (scheduler, poll,
// rule, run and execute jobs) is composed as apps/worker composes it and driven
// from the job ledger, one queued row at a time. FakeTikTok stands in for TikTok.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionRunner,
  ActionStepOutcomeObserver,
  PgActionRunStore,
  PgReviewQueue,
  PgSuggestionStore,
  actionRunAdvanceJob,
  loadBrandName,
  loadConnectionInfo,
} from '@feedbouncer/actions';
import {
  CompositeActionOutcomeObserver,
  ModerationActions,
  PgReviewModeReader,
  PgTikTokPolling,
  TikTokPollScheduler,
  connectionLifecycleJob,
  executeActionJob,
  ingestCommentJob,
  tiktokAdsPollJob,
  tiktokPollJob,
  type TikTokPollSettings,
} from '@feedbouncer/comments';
import { systemClock, type Platform } from '@feedbouncer/connectors';
import {
  JobMetrics,
  JobProducer,
  JobRegistry,
  PgJobLedger,
  QueueSet,
  createJobProcessor,
  createProducerConnection,
  policyResolver,
} from '@feedbouncer/jobs';
import {
  PgEvaluationStore,
  PgRuleStore,
  RuleActionFallback,
  RuleSetCache,
  RuleStepFallback,
  RuleTrigger,
  ruleEvaluateJob,
} from '@feedbouncer/rules';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import {
  WEB,
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
} from './testing/harness.js';

const TIKTOK = { appId: '7300000000000001', appSecret: 'tiktok-app-secret-0123456789' };
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MINUTE = 60_000;
const DAY = 86_400_000;
const ACTION_ENDPOINTS = [
  'businessCommentHide',
  'businessCommentDelete',
  'businessReplyCreate',
  'adCommentStatusUpdate',
  'adCommentDelete',
  'adCommentPost',
] as const;
// The worker's defaults (apps/worker/src/env.ts).
const SETTINGS: TikTokPollSettings = {
  pollIntervalSec: 300,
  quietVideoPollIntervalSec: 21_600,
  activeVideoDays: 30,
  videoDiscoveryIntervalSec: 900,
  deepScanIntervalSec: 86_400,
  sourceUnavailableRetrySec: 21_600,
  maxSourcesPerJob: 25,
  adsPollIntervalSec: 300,
  adsOverlapSec: 900,
  adsFullScanIntervalSec: 86_400,
  maxPagesPerJob: 20,
};

let api: TestApi;
let fake: FakeTikTok;
let f: OrgFixture;
/** TikTok's request id of every answer, by API path, oldest first. */
const requestIds: { path: string; requestId: string }[] = [];
/** The worker's clock: the scheduler and the poll jobs read it. */
let now = Date.now();
let worker: {
  scheduler: TikTokPollScheduler;
  drain(): Promise<string[]>;
  close(): Promise<void>;
};

beforeAll(async () => {
  fake = new FakeTikTok(TIKTOK);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { request_id?: string } | null;
    if (body?.request_id)
      requestIds.push({ path: new URL(String(input)).pathname, requestId: body.request_id });
    return res;
  };
  api = await startTestApi({ tiktok: TIKTOK, tiktokAds: TIKTOK }, { fetch });
  f = await orgWithRoles(api, 'tte2e');
  worker = buildWorker(api);
});
afterAll(async () => {
  await worker?.close();
  await api?.close();
});

/** The worker's job registry for TikTok (apps/worker/src/registries.ts), minus the AI stages, which are off here. */
function buildWorker(t: TestApi) {
  const { registry, stack } = t.deps.connectors!;
  const env = t.deps.env;
  const log = t.deps.log;
  const store = t.deps.comments!.store;
  const capabilities = (p: Platform) => registry.get(p)?.capabilities;
  const redis = createProducerConnection(env.redisUrl.href);
  redis.on('error', () => {});
  const jobs = new JobRegistry();
  const ledger = new PgJobLedger(t.pool);
  const metrics = new JobMetrics(log);
  const queues = new QueueSet({
    connection: redis,
    prefix: env.jobs.prefix,
    laneOf: jobs.laneOf(),
  });
  const producer = new JobProducer({
    ledger,
    jobs,
    connectors: registry,
    queues,
    metrics,
    dedupWindowMs: env.jobs.dedupWindowMs,
  });
  const applied = new RuleTrigger(producer);
  const evaluations = new PgEvaluationStore(t.pool);
  const actions = new ModerationActions({
    pool: t.pool,
    store,
    producer,
    capabilities,
    clock: systemClock,
    log,
  });
  const runs = new PgActionRunStore(t.pool);
  const runner = new ActionRunner({
    pool: t.pool,
    runs,
    review: new PgReviewQueue(t.pool),
    comments: store,
    actions,
    connection: (scope) => loadConnectionInfo(t.pool, scope, capabilities),
    brandName: (scope) => loadBrandName(t.pool, scope),
    producer,
    clock: systemClock,
    log,
    observer: new RuleStepFallback({ evaluations, log }),
  });
  jobs.register(
    ingestCommentJob({
      runtime: stack.runtime,
      directory: stack.directory,
      store,
      clock: systemClock,
      observer: { onIngested: () => {} },
      applied,
    }),
  );
  jobs.register(actionRunAdvanceJob(runner));
  jobs.register(
    ruleEvaluateJob({
      comments: store,
      evaluations,
      cache: new RuleSetCache(new PgRuleStore(t.pool)),
      runner,
      suggestions: new PgSuggestionStore(t.pool),
      reviewMode: new PgReviewModeReader(t.pool, systemClock),
      log,
    }),
  );
  jobs.register(
    executeActionJob({
      pool: t.pool,
      runtime: stack.runtime,
      log,
      producer,
      clock: systemClock,
      outcomes: new CompositeActionOutcomeObserver([
        new RuleActionFallback({ evaluations, log }),
        new ActionStepOutcomeObserver({ runs, producer, log }),
      ]),
    }),
  );
  jobs.register(connectionLifecycleJob({ runtime: stack.runtime, log }));
  const polling = new PgTikTokPolling(t.pool);
  const pollDeps = {
    runtime: stack.runtime,
    polling,
    store,
    clock: () => new Date(now),
    settings: SETTINGS,
    applied,
  };
  jobs.register(tiktokPollJob(pollDeps));
  jobs.register(tiktokAdsPollJob(pollDeps));

  const scheduler = new TikTokPollScheduler({
    polling,
    producer,
    clock: () => new Date(now),
    platforms: ['tiktok', 'tiktok_ads'],
    tickSec: 30,
    maxConnectionsPerTick: 200,
    intervals: { tiktok: SETTINGS.pollIntervalSec, tiktok_ads: SETTINGS.adsPollIntervalSec },
    log,
  });
  const processor = (platform: Platform, jobType: string) =>
    createJobProcessor({
      platform,
      lane: jobs.laneOf()(jobType),
      laneOf: jobs.laneOf(),
      ledger,
      jobs,
      policyFor: policyResolver(env.jobs, jobs),
      dlqRetentionMs: env.jobs.dlqRetentionMs,
      workerId: 'tiktok-e2e',
      log,
      metrics,
    });

  /** Runs queued jobs, oldest first, until none is left; any failed run fails the test. */
  async function drain(): Promise<string[]> {
    const ran: string[] = [];
    for (let round = 0; round < 25; round++) {
      const { rows } = await t.pool.query<{ id: string; job_type: string; platform: Platform }>(
        `SELECT id, job_type, platform FROM job_ledger WHERE state = 'queued' ORDER BY created_at, id`,
      );
      if (rows.length === 0) return ran;
      for (const r of rows) {
        const job = {
          id: r.id,
          name: r.job_type,
          data: { v: 1, ledgerId: r.id },
          moveToDelayed: async () => {},
        };
        try {
          await processor(r.platform, r.job_type)(job);
        } catch (err) {
          const row = await ledger.get(r.id);
          throw new Error(
            `${r.job_type} on ${r.platform} did not complete: ${err instanceof Error ? err.message : 'unknown'} (${row?.lastErrorKind ?? '-'}/${row?.lastErrorCode ?? '-'})`,
            { cause: err },
          );
        }
        ran.push(r.job_type);
      }
    }
    throw new Error('jobs did not settle');
  }

  return {
    scheduler,
    drain,
    async close() {
      await queues.close();
      await redis.quit().catch(() => {});
    },
  };
}

const base = () => `/api/v1/orgs/${f.orgId}/brands/${f.brandId}`;
const call = async (method: string, path: string, body?: unknown) =>
  api.req(method, `${base()}${path}`, { cookie: f.admin.cookie, body });

/** authorize -> consent at TikTok -> callback -> picker -> connect, as the brand's admin. */
async function connect(platform: 'tiktok' | 'tiktok_ads', authCode: string, id: string) {
  const authorized = await call('POST', `/connections/${platform}/authorize`, {});
  expect(authorized.status).toBe(200);
  const state = new URL(authorized.body.authorizationUrl).searchParams.get('state')!;
  const cb = await api.req(
    'GET',
    `/api/v1/oauth/${platform}/callback?auth_code=${authCode}&state=${state}`,
    { cookie: f.admin.cookie },
  );
  expect(cb.status).toBe(302);
  const grant = new RegExp(
    `^${WEB}/orgs/${f.orgId}/brands/${f.brandId}/connections/${platform}/select\\?grant=(${UUID_RE})$`,
  ).exec(String(cb.headers.location))![1]!;
  const r = await call('POST', `/connections/${platform}/grants/${grant}/connect`, {
    accountIds: [id],
  });
  expect(r.status).toBe(200);
  expect(r.body.results).toEqual([
    expect.objectContaining({ externalAccountId: id, status: 'connected' }),
  ]);
  const connectionId = r.body.results[0].connectionId as string;
  // Rules act straight away rather than suggesting for the first 7 days.
  const ended = await call('POST', `/connections/${connectionId}/review-mode/end`, {
    pending: 'leave',
  });
  expect(ended.body).toEqual({ status: 'ended', pendingCount: 0 });
  return connectionId;
}

const sec = (ms: number) => Math.floor(ms / 1000);
const actionCalls = () => ACTION_ENDPOINTS.reduce((n, e) => n + fake.calls(e).length, 0);
const lastRequestId = (suffix: string) =>
  requestIds.filter((r) => r.path.endsWith(suffix)).at(-1)?.requestId;

async function stored() {
  const r = await api.pool.query<{ id: string; external_id: string; platform_state: string }>(
    `SELECT id, external_id, platform_state FROM comment WHERE organization_id = $1 ORDER BY external_id`,
    [f.orgId],
  );
  return r.rows;
}
async function listed() {
  const r = await call('GET', '/comments?limit=100');
  expect(r.status).toBe(200);
  return r.body.comments as {
    id: string;
    platform: string;
    origin: string;
    mediaExternalId: string;
    sourcePermalink: string | null;
  }[];
}
async function actionsOn(commentId: string) {
  const r = await api.pool.query<{
    kind: string;
    rule_id: string | null;
    status: string;
    completed_at: Date | null;
    platform_ref: string | null;
  }>(
    `SELECT kind, rule_id, status, completed_at, platform_ref FROM moderation_action
      WHERE organization_id = $1 AND comment_id = $2 ORDER BY created_at`,
    [f.orgId, commentId],
  );
  return r.rows;
}
async function secretsOf(connectionId: string) {
  const r = await api.pool.query<{ kind: string }>(
    'SELECT kind FROM connection_secret WHERE connection_id = $1 ORDER BY kind',
    [connectionId],
  );
  return r.rows.map((x) => x.kind);
}

describe('tiktok end to end', () => {
  it('organic and ad connections end to end', async () => {
    // A business account with a video posted yesterday, and an advertiser.
    const { businessId } = fake.addBusinessAccount({ username: 'shop.tt' });
    const { itemId: videoId } = fake.addVideo(businessId, { createdAtSec: sec(now - DAY) });
    const { advertiserId } = fake.addAdvertiser({ name: 'Spring ads' });
    const organicId = await connect('tiktok', fake.authCodeFor(businessId), businessId);
    const adsId = await connect('tiktok_ads', fake.authCodeFor(advertiserId), advertiserId);

    // An ad-only delete rule first, then a hide rule for every comment.
    const rule = async (body: object) => {
      const r = await call('POST', '/rules', { mode: 'enforce', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const deleteRule = await rule({
      name: 'iPhone giveaways on ads',
      conditions: { type: 'keyword', terms: ['iphone'] },
      actions: [{ type: 'delete', confirmIrreversible: true }],
      appliesTo: 'ad',
    });
    const hideRule = await rule({
      name: 'Scam links',
      conditions: { type: 'link_domain', mode: 'blocklist', domains: ['scam.example.com'] },
      actions: [{ type: 'hide' }],
      appliesTo: 'all',
    });

    // The first pass of each connection is the backfill: nothing to import yet.
    expect((await worker.scheduler.tick()).enqueued).toBe(2);
    await worker.drain();
    expect(await stored()).toEqual([]);

    // New comments arrive on the video and on the ad.
    const scam = fake.addComment(videoId, {
      text: 'buy followers at scam.example.com',
      createdAtSec: sec(now + MINUTE),
    }).commentId;
    const fire = fake.addComment(videoId, {
      text: '🔥',
      parentId: scam,
      createdAtSec: sec(now + 2 * MINUTE),
    }).commentId;
    const ad = { adId: '1900000000000000001', itemId: '7400000000000000001' };
    const iphone = fake.addAdComment(advertiserId, {
      ...ad,
      text: 'free iphone scam.example.com',
      createdAt: new Date(now + 3 * MINUTE),
    }).commentId;

    // One poll interval later.
    now += 5 * MINUTE;
    expect((await worker.scheduler.tick()).enqueued).toBe(2);
    const ran = await worker.drain();
    expect(ran).toEqual(expect.arrayContaining(['tiktok_poll', 'tiktok_ads_poll']));

    const rows = await stored();
    expect(rows.map((r) => r.external_id).sort()).toEqual([scam, fire, iphone].sort());
    const idOf = (ext: string) => rows.find((r) => r.external_id === ext)!.id;
    // Labels and links as stored, deleted comments included (the API list leaves those out).
    const all = await api.deps.comments!.store.list(
      { organizationId: f.orgId, brandId: f.brandId },
      { before: null, limit: 100 },
    );
    const row = (ext: string) => all.find((c) => c.id === idOf(ext));
    const videoLink = `https://www.tiktok.com/@shop.tt/video/${videoId}`;
    const adLink = `https://www.tiktok.com/@/video/${ad.itemId}`;
    expect(row(scam)).toMatchObject({ origin: 'organic', sourcePermalink: videoLink });
    expect(row(fire)).toMatchObject({ origin: 'organic', sourcePermalink: videoLink });
    expect(row(iphone)).toMatchObject({ origin: 'ad', sourcePermalink: adLink });
    const sources = await api.pool.query<{ external_id: string; kind: string; source: string }>(
      `SELECT c.external_id, s.kind, s.external_id AS source FROM comment c
         JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id
        WHERE c.organization_id = $1 ORDER BY c.external_id`,
      [f.orgId],
    );
    expect(sources.rows).toEqual(
      [
        { external_id: scam, kind: 'video', source: videoId },
        { external_id: fire, kind: 'video', source: videoId },
        { external_id: iphone, kind: 'ad_post', source: ad.adId },
      ].sort((a, b) => a.external_id.localeCompare(b.external_id)),
    );
    // The comments the API lists carry the same labels and links.
    const listedNow = await listed();
    const view = (ext: string) => listedNow.find((c) => c.id === idOf(ext));
    for (const ext of [scam, fire])
      expect(view(ext)).toMatchObject({
        platform: 'tiktok',
        origin: 'organic',
        mediaExternalId: videoId,
        sourcePermalink: videoLink,
      });
    expect(view(iphone)).toBeUndefined();

    // The scam comment is hidden on TikTok; the reply is left alone.
    expect(fake.commentState(scam)).toBe('HIDDEN');
    expect(fake.commentState(fire)).toBe('PUBLIC');
    expect(await actionsOn(idOf(fire))).toEqual([]);
    const [hide] = await actionsOn(idOf(scam));
    expect(hide).toMatchObject({ kind: 'hide', rule_id: hideRule, status: 'applied' });
    expect(hide!.completed_at).toBeInstanceOf(Date);
    expect(hide!.platform_ref).toMatch(/^[A-Za-z0-9]{1,64}$/);
    expect(hide!.platform_ref).toBe(lastRequestId('business/comment/hide/'));

    // TIKTOK_ADS_ACTIONS includes delete: the ad comment is deleted, by the ad-only rule.
    expect(fake.commentState(iphone)).toBe('DELETED');
    const [del] = await actionsOn(idOf(iphone));
    expect(del).toMatchObject({ kind: 'delete', rule_id: deleteRule, status: 'applied' });
    expect(del!.completed_at).toBeInstanceOf(Date);
    expect(del!.platform_ref).toMatch(/^[A-Za-z0-9]{1,64}$/);
    expect(del!.platform_ref).toBe(lastRequestId('comment/delete/'));
    expect(await actionsOn(idOf(scam))).toHaveLength(1);
    expect(await actionsOn(idOf(iphone))).toHaveLength(1);

    // Everything again: the same slot enqueues nothing, and later passes (deep scan and
    // ads full scan included) store no new comment and repeat no action.
    const calls = actionCalls();
    const actionCount = async () =>
      (
        await api.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM moderation_action WHERE organization_id = $1',
          [f.orgId],
        )
      ).rows[0]!.n;
    const actionsBefore = await actionCount();
    expect((await worker.scheduler.tick()).enqueued).toBe(0);
    for (const step of [5 * MINUTE, DAY]) {
      now += step;
      expect((await worker.scheduler.tick()).enqueued).toBe(2);
      await worker.drain();
    }
    expect((await stored()).map((r) => r.external_id).sort()).toEqual([scam, fire, iphone].sort());
    expect(await actionCount()).toBe(actionsBefore);
    expect(actionCalls()).toBe(calls);

    // Disconnect the advertiser: its tokens go, its job is no longer scheduled, and
    // the organic account keeps syncing.
    expect(await secretsOf(adsId)).not.toEqual([]);
    const gone = await call('DELETE', `/connections/${adsId}`);
    expect(gone.status).toBe(204);
    await worker.drain();
    expect(await secretsOf(adsId)).toEqual([]);
    expect(await secretsOf(organicId)).toEqual(['access_token', 'refresh_token']);
    const late = fake.addComment(videoId, {
      text: 'when is the next drop?',
      createdAtSec: sec(now + MINUTE),
    }).commentId;
    now += 5 * MINUTE;
    expect((await worker.scheduler.tick()).enqueued).toBe(1);
    expect(await worker.drain()).not.toContain('tiktok_ads_poll');
    expect((await stored()).map((r) => r.external_id)).toContain(late);
    const adsJobs = await api.pool.query(
      `SELECT 1 FROM job_ledger
        WHERE connection_id = $1 AND job_type = 'tiktok_ads_poll' AND idempotency_key = $2`,
      [adsId, `tiktok_ads_poll:${Math.floor(now / 1000 / SETTINGS.adsPollIntervalSec)}`],
    );
    expect(adsJobs.rowCount).toBe(0);
    // Stored comments are kept.
    expect((await stored()).map((r) => r.external_id)).toContain(iphone);
  });
});
