// Runs ad discovery then the ad_poll handler over the Pg stores and the real
// connector runtime, with one FakeGraph as Facebook, Instagram and Ads.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
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
import { createMetaAdsConnector } from '@feedbouncer/connector-meta-ads';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { classifyFailure, type JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { PgAdTracking } from '../ads/tracking.js';
import { ModerationActions } from '../actions.js';
import type { ActionKind } from '../action-kinds.js';
import { adDiscoveryJob } from './discovery.js';
import { ingestCommentJob } from './ingest.js';
import { executeActionJob } from './execute.js';
import { adPollJob, type PollSettings } from './poll.js';
import { DISCOVERY_JOB, EXECUTE_JOB, INGEST_JOB, POLL_JOB } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-poll-test', 'error', () => {});

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let graph: FakeGraph;
let pageId: string;
let igUserId: string;
let adAccountId: string;
let fbScope: ConnectionScope;
let igScope: ConnectionScope;
let adsScope: ConnectionScope;
let registry: ConnectorRegistry;
let store: PgCommentStore;
let makeRuntime: () => ConnectorRuntime;
let runtime: ConnectorRuntime;
let directory: PgConnectionDirectory;
let tracking: PgAdTracking;
const nowMs = Date.UTC(2026, 9, 14, 12, 0, 0);
let t = nowMs;
const clock: Clock = { now: () => t };
const advance = (ms: number) => {
  t += ms;
};
let bucket = 0;

const defaults: PollSettings = {
  intervalSec: 120,
  graceDays: 7,
  maxSourcesPerJob: 100,
  unavailableRetrySec: 21_600,
  igDeepScanSec: 86_400,
  // Small enough that a 100-comment page spaced 1 s apart crosses it.
  overlapMs: 60_000,
  softDeadlineMs: 100_000,
  pageSize: 100,
};
let settings: PollSettings;

type PollResult = {
  sources: number;
  done: number;
  resumed: number;
  unavailable: number;
  created: number;
  updated: number;
};

const jobCtx = (scope: ConnectionScope, platform: Platform, jobType: string): JobContext => ({
  scope,
  platform,
  jobType,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(60_000),
  log,
});
const platformOf = (s: ConnectionScope): Platform =>
  s.connectionId === igScope.connectionId ? 'instagram' : 'facebook';

const discover = () =>
  adDiscoveryJob({ runtime, directory, tracking, clock }).handle(
    jobCtx(adsScope, 'meta_ads', DISCOVERY_JOB.type),
    { bucket: ++bucket },
  );
const poll = async (scope: ConnectionScope, b = 1): Promise<PollResult> =>
  (await adPollJob({ runtime, directory, store, tracking, clock, settings }).handle(
    jobCtx(scope, platformOf(scope), POLL_JOB.type),
    POLL_JOB.payload.parse({ bucket: b }),
  )) as PollResult;
const ingestRef = (
  scope: ConnectionScope,
  c: { sourceExternalId: string; commentExternalId: string },
) =>
  ingestCommentJob({ runtime, directory, store, clock }).handle(
    jobCtx(scope, platformOf(scope), INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      ...c,
      event: 'created',
      platformEventSec: Math.floor(t / 1000),
      changeId: '0123456789abcdef',
    }),
  );
const ingest = (scope: ConnectionScope, c: { postId: string; commentId: string }) =>
  ingestRef(scope, { sourceExternalId: c.postId, commentExternalId: c.commentId });
const ingestIg = (scope: ConnectionScope, c: { mediaId: string; commentId: string }) =>
  ingestRef(scope, { sourceExternalId: c.mediaId, commentExternalId: c.commentId });
const listView = (s: ConnectionScope) =>
  store.list(s, { before: null, limit: 100, connectionId: s.connectionId });

const tenant = (s: ConnectionScope) => [s.organizationId, s.brandId];
const countFor = async (s: ConnectionScope, ext?: string) =>
  Number(
    (
      await pool.query(
        `SELECT count(*) AS n FROM comment WHERE organization_id = $1 AND brand_id = $2
            AND connection_id = $3 AND ($4::text IS NULL OR external_id = $4)`,
        [...tenant(s), s.connectionId, ext ?? null],
      )
    ).rows[0].n,
  );
const pollRowOf = async (sourceExt: string) =>
  (
    await pool.query<{ resume_cursor: string | null; last_error_code: string | null }>(
      `SELECT sp.resume_cursor, sp.last_error_code FROM source_poll sp
         JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
        WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND s.external_id = $3`,
      [...tenant(fbScope), sourceExt],
    )
  ).rows[0];
const resumeCursorOf = async (sourceExt: string) => (await pollRowOf(sourceExt))?.resume_cursor;
const unavailableOf = async (sourceExt: string) => (await pollRowOf(sourceExt))?.last_error_code;
const statusOf = async (s: ConnectionScope) =>
  (
    await pool.query<{ status: string }>(
      'SELECT status FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
      [...tenant(s), s.connectionId],
    )
  ).rows[0]?.status;

async function userTokenFor(meta: Connector, uid: string): Promise<string> {
  const verifier = 'v'.repeat(48);
  const url = meta.buildAuthorizationUrl({
    state: 'st',
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    redirectUri: 'https://app.test/cb',
    scopes: meta.capabilities.defaultScopes,
  });
  const { code } = graph.consent(url, uid);
  const exchange = async (form: Record<string, string>) => {
    const res = await graph.fetch('https://graph.facebook.com/v26.0/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '111',
        client_secret: APP_SECRET,
        ...form,
      }).toString(),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  };
  const short = await exchange({
    code,
    redirect_uri: 'https://app.test/cb',
    code_verifier: verifier,
  });
  return exchange({ grant_type: 'fb_exchange_token', fb_exchange_token: short });
}

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'comments-poll-test', onIdleError: () => {} });
  a = await seedTenant(ctx.c, 'poll-a');
  await ctx.c.query('DELETE FROM connection WHERE id = $1', [a.connectionId]);

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => t });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  ({ igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' }));
  ({ adAccountId } = graph.addAdAccount(userId, { name: 'Shop ads' }));

  const meta = {
    appId: '111',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  };
  const adsConnector = createMetaAdsConnector({ meta, activeStatuses: ['ACTIVE'] }, { clock });
  const userToken = await userTokenFor(adsConnector, userId);

  const creds = new CredentialStore(pool, testKeyring(['k1']));
  const connect = async (platform: string, ext: string, token: string) => {
    const r = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [a.organizationId, a.brandId, platform, ext],
    );
    const scope = {
      organizationId: a.organizationId,
      brandId: a.brandId,
      connectionId: r.rows[0]!.id,
    };
    await creds.put(scope, 'access_token', new Secret(token), null);
    return scope;
  };
  fbScope = await connect('facebook', pageId, page.pageToken);
  igScope = await connect('instagram', igUserId, page.pageToken);
  adsScope = await connect('meta_ads', adAccountId, userToken);

  registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(meta, { clock }));
  registry.register(createInstagramConnector({ meta }, { clock }));
  registry.register(adsConnector);
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: graph.fetch });
  directory = new PgConnectionDirectory(pool);
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
  store = new PgCommentStore(pool);
  tracking = new PgAdTracking(pool, store);
  // The budget runs on wall-clock time: a fresh one per test (and after a platform throttle).
  makeRuntime = () =>
    new ConnectorRuntime({
      registry,
      directory,
      vault,
      tokens,
      budget: memoryBudget(),
      clock,
      log,
      http,
    });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  t = nowMs;
  settings = { ...defaults };
  runtime = makeRuntime();
  for (const table of ['source', 'meta_ad'])
    await ctx.c.query(
      `DELETE FROM ${table} WHERE organization_id = $1 AND brand_id = $2`,
      tenant(fbScope),
    );
  await ctx.c.query(
    `UPDATE connection SET status = 'active' WHERE organization_id = $1 AND brand_id = $2`,
    tenant(fbScope),
  );
  graph.removeAds(adAccountId);
});

describe('ad poll job', () => {
  it('ingests comments on a facebook dark post with an ad label (AC: within one interval)', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    await discover();
    graph.addComment(pageId, { postId, message: 'scam link', createdAtMs: nowMs - 60_000 });
    expect(await poll(fbScope)).toEqual({
      sources: 1,
      done: 1,
      resumed: 0,
      unavailable: 0,
      created: 1,
      updated: 0,
    });
    expect(await listView(fbScope)).toEqual([
      expect.objectContaining({
        body: 'scam link',
        origin: 'ad',
        ads: [expect.objectContaining({ adAccountId })],
      }),
    ]);
  });

  it('webhook then poll is one row (Review Focus 1)', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    const { commentId } = graph.addComment(pageId, { postId, message: 'hi' });
    await ingest(fbScope, { postId, commentId });
    await discover();
    await poll(fbScope);
    expect(await countFor(fbScope, commentId)).toBe(1);
    expect((await listView(fbScope))[0]).toMatchObject({ origin: 'ad' });
  });

  it('two ads on one post ingest once and list both ads', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    graph.addAd(adAccountId, { storyId: postId });
    graph.addComment(pageId, { postId, message: 'x' });
    await discover();
    await poll(fbScope);
    expect(await countFor(fbScope)).toBe(1);
    expect((await listView(fbScope))[0]!.ads).toHaveLength(2);
  });

  it('instagram: different webhook media id still one row with origin ad; replies inline get parents', async () => {
    const top = graph.addIgComment(igUserId, { text: 'top' });
    const reply = graph.addIgComment(igUserId, {
      mediaId: top.mediaId,
      parentId: top.commentId,
      text: 'r',
    });
    // The webhook filed it under the "original" media id.
    await ingestIg(igScope, { mediaId: '17900000000000999', commentId: top.commentId });
    graph.addAd(adAccountId, { igMediaId: top.mediaId, igUserId });
    await discover();
    await poll(igScope);
    expect(await countFor(igScope, top.commentId)).toBe(1);
    const rows = await listView(igScope);
    expect(rows.find((r) => r.externalId === top.commentId)).toMatchObject({ origin: 'ad' });
    expect(rows.find((r) => r.externalId === reply.commentId)!.parentCommentId).not.toBeNull();
  });

  it('pages 1,000 comments across several jobs and loses nothing added mid-pass (Review Focus 5)', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    await discover();
    const base = nowMs - 2_000_000;
    for (let i = 0; i < 1000; i++)
      graph.addComment(pageId, { postId, message: `c${i}`, createdAtMs: base + i * 1000 });
    settings.softDeadlineMs = 0; // one page per job: exercises resume
    let r: PollResult;
    let i = 0;
    do {
      r = await poll(fbScope, 100 + i);
      if (i === 3) graph.addComment(pageId, { postId, message: 'late', createdAtMs: nowMs });
      i++;
    } while (r.resumed > 0 && i < 50);
    expect(i).toBeGreaterThan(5);
    advance(settings.intervalSec * 1000);
    settings.softDeadlineMs = 100_000;
    await poll(fbScope, 1000);
    expect(await countFor(fbScope)).toBe(1001);
  });

  it('a second poll reads only back to the high-water mark', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    await discover();
    for (let i = 0; i < 300; i++)
      graph.addComment(pageId, {
        postId,
        message: `c${i}`,
        createdAtMs: nowMs - 3_600_000 + i * 1000,
      });
    await poll(fbScope);
    advance(settings.intervalSec * 1000);
    graph.addComment(pageId, { postId, message: 'new', createdAtMs: t });
    const before = graph.calls().length;
    expect(await poll(fbScope, 2)).toMatchObject({ done: 1, created: 1 });
    expect(graph.calls().length - before).toBe(1);
  });

  it('a deleted post marks only that source unavailable; others still poll (Review Focus 2)', async () => {
    const pa = graph.addDarkPost(pageId).postId;
    const pb = graph.addDarkPost(pageId).postId;
    graph.addAd(adAccountId, { storyId: pa });
    graph.addAd(adAccountId, { storyId: pb });
    graph.addComment(pageId, { postId: pb, message: 'ok' });
    await discover();
    graph.removePost(pa);
    const r = await poll(fbScope);
    expect(r).toMatchObject({ unavailable: 1, done: 1 });
    expect(await unavailableOf(pa)).toBe('source_missing');
    expect(await countFor(fbScope)).toBe(1);
    expect(await statusOf(fbScope)).toBe('active');
    // Not due again until the retry time.
    expect((await poll(fbScope, 2)).sources).toBe(0);
  });

  it('an unreadable IG media does not flag the instagram connection', async () => {
    // No igUserId: the brand has one IG connection; the media is unknown to it.
    graph.addAd(adAccountId, { igMediaId: '17900000000000777' });
    await discover();
    graph.failNext(10); // permission error on that media listing
    const r = await poll(igScope);
    expect(r.unavailable).toBe(1);
    expect(await statusOf(igScope)).toBe('active');
  });

  it('a throttle mid-pass saves the cursor and defers; the next run resumes', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    await discover();
    for (let i = 0; i < 250; i++)
      graph.addComment(pageId, {
        postId,
        message: `c${i}`,
        createdAtMs: nowMs - 500_000 + i * 1000,
      });
    graph.throttleNext(80004, 1, { afterCalls: 1 });
    const err: unknown = await poll(fbScope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'rate_limited' });
    expect(await resumeCursorOf(postId)).not.toBeNull();
    // Deferred: not due again before the platform's retry time.
    expect((await poll(fbScope, 2)).sources).toBe(0);
    advance(60_000);
    runtime = makeRuntime(); // the platform block has expired
    expect(await poll(fbScope, 3)).toMatchObject({ done: 1 });
    expect(await countFor(fbScope)).toBe(250);
  });

  it('a cursor that does not advance ends the pass instead of looping', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    await discover();
    for (let i = 0; i < 150; i++) graph.addComment(pageId, { postId, createdAtMs: nowMs - i });
    const client = await runtime.connect(fbScope);
    const real = client.listComments.bind(client);
    vi.spyOn(runtime, 'connect').mockResolvedValue(
      Object.assign(Object.create(client) as typeof client, {
        listComments: async (...args: Parameters<typeof client.listComments>) => {
          const page = await real(...args);
          return { ...page, nextCursor: args[0].cursor ?? page.nextCursor };
        },
      }),
    );
    try {
      const r = await poll(fbScope);
      expect(r).toMatchObject({ unavailable: 1, done: 0 });
      expect(await unavailableOf(postId)).toBe('cursor_stalled');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('ad comments can be hidden, deleted and replied to with existing actions (AC)', async () => {
    const actions = new ModerationActions({
      pool,
      store,
      producer: {
        enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
      },
      capabilities: (p) => registry.get(p)?.capabilities,
      clock,
      log,
    });
    const execute = executeActionJob({
      pool,
      runtime,
      log,
      producer: {
        enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
      },
      clock,
    });
    const act = async (
      scope: ConnectionScope,
      externalId: string,
      kind: ActionKind,
      text?: string,
    ) => {
      const row = (await listView(scope)).find((r) => r.externalId === externalId)!;
      expect(row.origin).toBe('ad');
      const r = await actions.request({
        scope,
        commentId: row.id,
        kind,
        actor: { type: 'user', userId: a.userId },
        requestKey: `rk-${randomUUID()}`,
        ...(text !== undefined ? { text } : {}),
      });
      if (r.status !== 'accepted') throw new Error(`expected accepted, got ${r.status}`);
      return execute.handle(
        jobCtx(scope, platformOf(scope), EXECUTE_JOB.type),
        EXECUTE_JOB.payload.parse({ actionId: r.action.id }),
      );
    };

    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    const [f1, f2, f3] = ['a', 'b', 'c'].map(
      (m) => graph.addComment(pageId, { postId, message: m, createdAtMs: t - 60_000 }).commentId,
    );
    const top = graph.addIgComment(igUserId, { text: 'x', createdAtMs: t - 60_000 });
    const [i2, i3] = ['y', 'z'].map(
      (text) =>
        graph.addIgComment(igUserId, { mediaId: top.mediaId, text, createdAtMs: t - 60_000 })
          .commentId,
    );
    graph.addAd(adAccountId, { igMediaId: top.mediaId, igUserId });
    await discover();
    await poll(fbScope);
    await poll(igScope);

    await act(fbScope, f1!, 'hide');
    await act(fbScope, f2!, 'delete');
    await act(fbScope, f3!, 'public_reply', 'thanks');
    expect(graph.state(f1!)).toBe('hidden');
    expect(graph.state(f2!)).toBe('deleted');
    expect(graph.replies(f3!)).toHaveLength(1);

    await act(igScope, top.commentId, 'hide');
    await act(igScope, i2!, 'delete');
    await act(igScope, i3!, 'public_reply', 'thanks');
    expect(graph.igState(top.commentId)).toBe('hidden');
    expect(graph.igState(i2!)).toBe('deleted');
    expect(graph.igReplies(i3!)).toHaveLength(1);
  });

  it('already hidden or deleted comments are not resurrected', async () => {
    const hidden = graph.addIgComment(igUserId, { text: 'h', createdAtMs: t - 60_000 });
    const gone = graph.addIgComment(igUserId, {
      mediaId: hidden.mediaId,
      text: 'd',
      createdAtMs: t - 60_000,
    });
    graph.ownerHides(hidden.commentId); // hidden on the platform before the first poll
    await store.recordDeleted(
      igScope,
      { sourceExternalId: gone.mediaId, externalId: gone.commentId },
      { syncedAt: new Date(t - 1000), occurredAt: new Date(t - 1000) },
    );
    graph.addAd(adAccountId, { igMediaId: hidden.mediaId, igUserId });
    await discover();
    await poll(igScope);
    const rows = await listView(igScope);
    expect(rows.find((r) => r.externalId === hidden.commentId)).toMatchObject({
      platformState: 'hidden',
    });
    expect(rows.find((r) => r.externalId === gone.commentId)).toMatchObject({
      platformState: 'deleted',
    });
  });

  it('retired ads stop being polled after the grace period (Review Focus 4)', async () => {
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await discover();
    graph.setAdStatus(adId, 'PAUSED');
    await discover();
    advance(6 * 86_400_000);
    expect((await poll(fbScope, 10)).sources).toBe(1);
    advance(2 * 86_400_000);
    expect((await poll(fbScope, 11)).sources).toBe(0);
  });

  it('ad polling cannot exhaust the read budget used by webhook ingest (AC: never blocks organic)', async () => {
    // Facebook: 200 points per 60 s, 50 reserved for urgent work, so background is capped at 75.
    for (let i = 0; i < 120; i++) {
      const { postId } = graph.addDarkPost(pageId);
      graph.addAd(adAccountId, { storyId: postId });
      graph.addComment(pageId, { postId, message: `ad${i}` });
    }
    await discover();
    const err: unknown = await poll(fbScope).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'rate_limited', code: 'budget_exhausted' });
    expect(await countFor(fbScope)).toBe(75);
    const organic = graph.addComment(pageId, { message: 'organic' });
    expect(await ingest(fbScope, organic)).toMatchObject({ outcome: 'created' });
  });

  it('two overlapping poll jobs for one connection create no duplicates (Review Focus 1)', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    for (let i = 0; i < 50; i++) graph.addComment(pageId, { postId, message: `c${i}` });
    await discover();
    await Promise.all([poll(fbScope, 1), poll(fbScope, 2)]);
    expect(await countFor(fbScope)).toBe(50);
  });
});
