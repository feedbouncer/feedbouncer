// Runs the connection_backfill handler over the Pg stores and the real connector
// runtime, with one FakeGraph as Facebook and Instagram.
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
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { BACKFILL_DEFAULTS } from '../backfill/settings.js';
import { PgBackfillStore } from '../backfill/store.js';
import { ingestCommentJob } from './ingest.js';
import { connectionBackfillJob } from './backfill.js';
import { BACKFILL_JOB, BACKFILL_MAX_ATTEMPTS, type BackfillPayload } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-backfill-test', 'error', () => {});
const DAY = 86_400_000;
const nowMs = Date.UTC(2026, 9, 14, 12, 0, 0);

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let graph: FakeGraph;
let pageId: string;
let igUserId: string;
let pageToken: string;
let scope: ConnectionScope;
let igScope: ConnectionScope;
let runtime: ConnectorRuntime;
let directory: PgConnectionDirectory;
let store: PgCommentStore;
let makeRuntime: () => ConnectorRuntime;
let t = nowMs;
const clock: Clock = { now: () => t };
const enqueued: { type: string; payload: unknown }[] = [];
const producer = {
  enqueue: async (r: { type: string; payload: unknown }) => {
    enqueued.push(r);
    return { status: 'enqueued', ledgerId: 'l', jobId: 'j' } as never;
  },
};
const settings = { ...BACKFILL_DEFAULTS, maxComments: 50, pageSize: 10 };
let backfill: PgBackfillStore;

const ctxFor = (s: ConnectionScope, platform: Platform = 'facebook'): JobContext => ({
  scope: s,
  platform,
  jobType: 'connection_backfill',
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(60_000),
  log,
});
const job = () =>
  connectionBackfillJob({ runtime, directory, store, backfill, producer, clock, settings });
async function start(s = scope, b = backfill): Promise<BackfillPayload> {
  const r = await b.request(s, new Date(t));
  if (r.kind === 'up_to_date') throw new Error('no run');
  return { runId: r.runId, segment: r.segment };
}
const rows = async (s = scope) =>
  (
    await pool.query(
      `SELECT external_id, platform_state, ingest_origin, posted_at, body FROM comment
        WHERE connection_id = $1 ORDER BY posted_at DESC`,
      [s.connectionId],
    )
  ).rows;
const view = async (s = scope) => (await backfill.views(s, new Date(t))).get(s.connectionId);
const commentCalls = () => graph.calls().filter((c) => c.path.includes('/comments')).length;

const meta = {
  appId: '111',
  appSecret: new Secret(APP_SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-backfill-test',
    onIdleError: () => {},
  });
  a = await seedTenant(ctx.c, 'backfill-a');
  await ctx.c.query('DELETE FROM connection WHERE id = $1', [a.connectionId]);
  store = new PgCommentStore(pool);
  directory = new PgConnectionDirectory(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
// Fresh Graph, connections and runtime per test: posts and budgets never leak.
beforeEach(async () => {
  t = nowMs;
  enqueued.length = 0;
  for (const table of ['comment', 'source', 'connection_backfill', 'connection'])
    await ctx.c.query(`DELETE FROM ${table} WHERE organization_id = $1 AND brand_id = $2`, [
      a.organizationId,
      a.brandId,
    ]);

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => t });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  pageToken = page.pageToken;
  ({ igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' }));

  const creds = new CredentialStore(pool, testKeyring(['k1']));
  const connect = async (platform: string, ext: string) => {
    const r = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [a.organizationId, a.brandId, platform, ext],
    );
    const s = {
      organizationId: a.organizationId,
      brandId: a.brandId,
      connectionId: r.rows[0]!.id,
    };
    await creds.put(s, 'access_token', new Secret(pageToken), null);
    return s;
  };
  scope = await connect('facebook', pageId);
  igScope = await connect('instagram', igUserId);

  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(meta, { clock }));
  registry.register(createInstagramConnector({ meta }, { clock }));
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: graph.fetch });
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
  runtime = makeRuntime();
  backfill = new PgBackfillStore(pool, settings);
});

describe('connection_backfill job', () => {
  it('imports in-window comments and replies newest first with platform timestamps', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - 3 * DAY }).postId;
    const old = graph.addPost(pageId, { createdAtMs: t - 45 * DAY }).postId;
    const c1 = graph.addComment(pageId, { postId: post, createdAtMs: t - 2 * DAY }).commentId;
    graph.addComment(pageId, { postId: post, parentId: c1, createdAtMs: t - DAY });
    graph.addComment(pageId, { postId: post, createdAtMs: t - 40 * DAY });
    graph.addComment(pageId, { postId: old, createdAtMs: t - DAY });
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toMatchObject({ result: 'completed', imported: 2, limited: false });
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.ingest_origin === 'backfill')).toBe(true);
    expect(r.map((x) => x.posted_at.getTime())).toEqual([t - DAY, t - 2 * DAY]);
  });

  it('reconnect after an outage imports outage comments on posts older than the outage', async () => {
    await job().handle(ctxFor(scope), await start());
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    await pool.query(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
       VALUES ($1, $2, 'system', 'connection.reconnect_required', 'connection', $3, $4)`,
      [a.organizationId, a.brandId, scope.connectionId, new Date(t + 10 * DAY)],
    );
    t += 12 * DAY;
    graph.addComment(pageId, { postId: post, createdAtMs: t - 1.5 * DAY });
    graph.addComment(pageId, { postId: post, createdAtMs: t - 11.5 * DAY });
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toMatchObject({ result: 'completed', imported: 1 });
  });

  it('account with no posts completes with zero', async () => {
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toEqual({ result: 'completed', imported: 0, limited: false });
    expect(await view()).toMatchObject({ status: 'completed', importedCount: 0, limitedTo: null });
  });

  it('stops at the cap, marks limited, and does not keep trying', async () => {
    for (let i = 0; i < 3; i++) {
      const post = graph.addPost(pageId, { createdAtMs: t - (i + 1) * 3_600_000 }).postId;
      for (let j = 0; j < 30; j++)
        graph.addComment(pageId, { postId: post, createdAtMs: t - (i + 1) * 3_600_000 + j });
    }
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toMatchObject({ result: 'completed', imported: 50, limited: true });
    expect(await rows()).toHaveLength(50);
    expect(await view()).toMatchObject({ limitedTo: 50 });
    expect(await backfill.request(scope, new Date(t + 60_000))).toEqual({ kind: 'up_to_date' });
  });

  it('does not mark limited when the account has exactly the cap', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - 3_600_000 }).postId;
    for (let j = 0; j < 50; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - 3_600_000 + j });
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toMatchObject({ result: 'completed', imported: 50, limited: false });
    expect(await view()).toMatchObject({ limitedTo: null });
  });

  it('re-running and receiving the same comment live creates no duplicates', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    const { commentId } = graph.addComment(pageId, { postId: post, createdAtMs: t - DAY });
    const p = await start();
    await job().handle(ctxFor(scope), p);
    await ingestCommentJob({ runtime, directory, store, clock }).handle(ctxFor(scope), {
      sourceExternalId: post,
      commentExternalId: commentId,
      event: 'created',
      platformEventSec: Math.floor(t / 1000),
      changeId: '0123456789abcdef',
    });
    await pool.query(
      `UPDATE connection_backfill SET status = 'running', sources_exhausted = false, source_cursor = NULL,
              source_queue = '{}', comment_cursor = NULL, imported_count = 0 WHERE connection_id = $1`,
      [scope.connectionId],
    );
    await job().handle(ctxFor(scope), p);
    expect(await rows()).toHaveLength(1);
  });

  it('live write after the backfill fetch wins', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    const { commentId } = graph.addComment(pageId, {
      postId: post,
      createdAtMs: t - DAY,
      message: 'v1',
    });
    const p = await start();
    const realUpsert = store.upsertFromPlatform.bind(store);
    let injected = false;
    store.upsertFromPlatform = async (s, c, o) => {
      if (!injected && c.externalId === commentId) {
        injected = true;
        await realUpsert(
          s,
          { ...c, body: 'v2 live' },
          { ...o, syncedAt: new Date(o.syncedAt.getTime() + 1), origin: 'live' },
        );
      }
      return realUpsert(s, c, o);
    };
    try {
      await job().handle(ctxFor(scope), p);
    } finally {
      store.upsertFromPlatform = realUpsert;
    }
    expect((await rows())[0].body).toBe('v2 live');
  });

  it('hidden comments are imported hidden and not re-actioned', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    const { commentId } = graph.addComment(pageId, { postId: post, createdAtMs: t - DAY });
    graph.hideComment(commentId);
    await job().handle(ctxFor(scope), await start());
    expect((await rows())[0].platform_state).toBe('hidden');
    const n = await pool.query(
      `SELECT count(*)::int AS n FROM moderation_action WHERE connection_id = $1`,
      [scope.connectionId],
    );
    expect(n.rows[0].n).toBe(0);
    expect(
      graph.calls().filter((c) => c.method !== 'GET' && !c.path.includes('oauth')),
    ).toHaveLength(0);
  });

  it('throttling defers without failing and resumes without re-reading done pages', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    for (let j = 0; j < 30; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - DAY + j });
    const p = await start();
    graph.throttleNext(80001, 1, { afterCalls: 2 });
    await expect(job().handle(ctxFor(scope), p)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(await view()).toMatchObject({ status: 'running', importedCount: 10 });
    const before = commentCalls();
    runtime = makeRuntime();
    t += 120_000;
    const out = await job().handle(ctxFor(scope), p);
    expect(out).toMatchObject({ result: 'completed', imported: 30 });
    expect(commentCalls() - before).toBe(2);
  });

  it('a segment that exhausts its retries is failed as platform_error and can be restarted', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    for (let j = 0; j < 30; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - DAY + j });
    const p = await start();
    graph.throttleNext(80001, 1, { afterCalls: 2 });
    const last = { ...ctxFor(scope), attempt: BACKFILL_MAX_ATTEMPTS };
    await expect(job().handle(last, p)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(await view()).toMatchObject({ status: 'failed', failureReason: 'platform_error' });
    expect((await backfill.request(scope, new Date(t))).kind).toBe('started');
  });

  it('resumes after a worker restart from the checkpoint', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    for (let j = 0; j < 30; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - DAY + j });
    const p = await start();
    graph.failNext(2, undefined, 2);
    await expect(job().handle(ctxFor(scope), p)).rejects.toMatchObject({ kind: 'transient' });
    const before = commentCalls();
    const fresh = connectionBackfillJob({
      runtime,
      directory,
      store,
      backfill: new PgBackfillStore(pool, settings),
      producer,
      clock,
      settings,
    });
    expect(await fresh.handle(ctxFor(scope), p)).toMatchObject({
      result: 'completed',
      imported: 30,
    });
    expect(commentCalls() - before).toBe(2);
  });

  it('continues in a new segment past the soft deadline', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    for (let j = 0; j < 30; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - DAY + j });
    const p = await start();
    const base = t;
    const stepping: Clock = { now: () => (t += 100_000) };
    const out = await connectionBackfillJob({
      runtime,
      directory,
      store,
      backfill,
      producer,
      clock: stepping,
      settings,
    }).handle(ctxFor(scope), p);
    expect(out).toMatchObject({ result: 'continued', nextSegment: 1 });
    expect(t).toBeGreaterThan(base);
    expect(enqueued.at(-1)).toMatchObject({
      type: 'connection_backfill',
      payload: { runId: p.runId, segment: 1 },
    });
    expect(await job().handle(ctxFor(scope), { ...p, segment: 1 })).toMatchObject({
      result: 'completed',
      imported: 30,
    });
    expect(await job().handle(ctxFor(scope), p)).toEqual({
      result: 'stopped',
      reason: 'not_current',
    });
  });

  it('revoked authorization mid-run stops, fails reconnect_required, and makes no more calls', async () => {
    for (let i = 0; i < 3; i++) {
      const post = graph.addPost(pageId, { createdAtMs: t - (i + 1) * DAY }).postId;
      for (let j = 0; j < 15; j++)
        graph.addComment(pageId, { postId: post, createdAtMs: t - (i + 1) * DAY + j });
    }
    const p = await start();
    graph.failNext(190, 460, 2);
    const out = await job().handle(ctxFor(scope), p);
    expect(out).toEqual({ result: 'stopped', reason: 'reconnect_required' });
    expect(await view()).toMatchObject({ status: 'failed', failureReason: 'reconnect_required' });
    const calls = graph.calls().length;
    expect(await job().handle(ctxFor(scope), p)).toMatchObject({ result: 'stopped' });
    expect(graph.calls().length).toBe(calls);
  });

  it('disconnect mid-run stops at the next page with no further Graph calls', async () => {
    const post = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    for (let j = 0; j < 30; j++)
      graph.addComment(pageId, { postId: post, createdAtMs: t - DAY + j });
    const p = await start();
    const before = graph.calls().length;
    const realUpsert = store.upsertFromPlatform.bind(store);
    let disconnected = false;
    store.upsertFromPlatform = async (s, c, o) => {
      if (!disconnected) {
        disconnected = true;
        await directory.disconnect(scope, a.userId);
        await backfill.cancel(scope, new Date(t));
      }
      return realUpsert(s, c, o);
    };
    let out;
    try {
      out = await job().handle(ctxFor(scope), p);
    } finally {
      store.upsertFromPlatform = realUpsert;
    }
    expect(out).toEqual({ result: 'stopped', reason: 'cancelled' });
    expect(graph.calls().length - before).toBe(2);
  });

  it('missing permission or a deleted post skips that source, records it, and completes', async () => {
    const x = graph.addPost(pageId, { createdAtMs: t - DAY }).postId;
    const y = graph.addPost(pageId, { createdAtMs: t - 2 * DAY }).postId;
    const z = graph.addPost(pageId, { createdAtMs: t - 3 * DAY }).postId;
    graph.addComment(pageId, { postId: x, createdAtMs: t - DAY });
    graph.addComment(pageId, { postId: y, createdAtMs: t - DAY });
    graph.addComment(pageId, { postId: z, createdAtMs: t - DAY });
    graph.failNextFor(`${x}/comments`, 200);
    graph.failNextFor(`${y}/comments`, 100, 33);
    const out = await job().handle(ctxFor(scope), await start());
    expect(out).toMatchObject({ result: 'completed', imported: 1 });
    expect((await view())!.skippedCount).toBe(2);
    const r = await pool.query(
      `SELECT skipped_sources FROM connection_backfill WHERE connection_id = $1`,
      [scope.connectionId],
    );
    expect(r.rows[0].skipped_sources).toEqual([
      { source: x, code: 'permission_denied' },
      { source: y, code: 'source_missing' },
    ]);
  });

  it('imports Instagram media comments', async () => {
    const m = graph.addIgMedia(igUserId, { createdAtMs: t - DAY }).mediaId;
    const top = graph.addIgComment(igUserId, { mediaId: m, createdAtMs: t - DAY }).commentId;
    graph.addIgComment(igUserId, { parentId: top, createdAtMs: t - DAY + 1 });
    const p = await start(igScope);
    const out = await job().handle(ctxFor(igScope, 'instagram'), p);
    expect(out).toMatchObject({ result: 'completed', imported: 2 });
    expect(await rows(igScope)).toHaveLength(2);
  });
});

describe('BACKFILL_JOB', () => {
  it('has a stable idempotency ref and platforms', () => {
    const ref = BACKFILL_JOB.externalRef({ runId: randomUUID(), segment: 3 });
    expect(ref).toMatch(/^backfill:[0-9a-f-]{36}:3$/);
    expect(BACKFILL_JOB.platforms).toEqual(['facebook', 'instagram']);
  });
});
