// Runs the ingest handler directly over the Pg comment store and the real
// connector runtime (Pg directory + vault), with FakeGraph as the platform.
// The job framework itself is covered by @feedbouncer/jobs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { JobError, classifyFailure, type JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { ingestCommentJob, type IngestObserver } from './ingest.js';
import { INGEST_JOB, type IngestPayload } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-ingest-test', 'error', () => {});

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t: Tenant;
let scope: ConnectionScope;
let store: PgCommentStore;
let graph: FakeGraph;
let pageId: string;
let nowMs = Date.UTC(2026, 9, 13, 12, 0, 0);
const clock: Clock = { now: () => nowMs };
const tick = (ms = 1_000) => {
  nowMs += ms;
};
const events: Parameters<IngestObserver['onIngested']>[0][] = [];
let deps: Omit<Parameters<typeof ingestCommentJob>[0], 'observer'>;
let job: ReturnType<typeof ingestCommentJob>;

// One-shot hold: the next Graph response is captured, then delivered only when
// released, so a fetch can be made to land after later jobs (stale read).
let holdNext: { reached: () => void; gate: Promise<void> } | null = null;
function holdNextResponse(): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const r = new Promise<void>((res) => (reached = res));
  const gate = new Promise<void>((res) => (release = res));
  holdNext = { reached, gate };
  return { reached: r, release };
}

const sec = (ms: number) => Math.floor(ms / 1000);
const jobCtx = (s: ConnectionScope = scope): JobContext => ({
  scope: s,
  platform: 'facebook',
  jobType: INGEST_JOB.type,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log,
});
const run = (p: IngestPayload, s?: ConnectionScope) =>
  job.handle(jobCtx(s), INGEST_JOB.payload.parse(p));
const payload = (
  c: { postId: string; commentId: string },
  event: IngestPayload['event'],
  atMs = nowMs,
): IngestPayload => ({
  sourceExternalId: c.postId,
  commentExternalId: c.commentId,
  event,
  platformEventSec: sec(atMs),
});
const rowsFor = async (externalId: string) =>
  (await pool.query('SELECT id FROM comment WHERE external_id = $1', [externalId])).rows;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'comments-ingest-test', onIdleError: () => {} });
  t = await seedTenant(ctx.c, 'ing');
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    pageId,
    t.connectionId,
  ]);
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  await creds.put(scope, 'access_token', new Secret(page.pageToken), null);

  const connector = createFacebookConnector(
    {
      appId: '111',
      appSecret: new Secret(APP_SECRET),
      graphVersion: 'v26.0',
      webhookVerifyToken: new Secret('v'.repeat(24)),
    },
    { clock },
  );
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const fetchVia: typeof fetch = async (input, init) => {
    const hold = holdNext;
    holdNext = null;
    const res = await graph.fetch(input, init);
    if (hold) {
      hold.reached();
      await hold.gate;
    }
    return res;
  };
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: fetchVia });
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
  const runtime = new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget: memoryBudget(),
    clock,
    log,
    http,
  });
  store = new PgCommentStore(pool);
  deps = { runtime, directory, store, clock };
  job = ingestCommentJob({ ...deps, observer: { onIngested: (e) => events.push(e) } });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(() => {
  tick();
  events.length = 0;
});

describe('comment ingest job', () => {
  it('created event: fetches and stores the comment with author and permalink', async () => {
    const c = graph.addComment(pageId, { message: 'buy now' });
    const r = await run(payload(c, 'created'));
    expect(r).toMatchObject({ outcome: 'created' });
    const row = await store.load(t, r.commentId as string);
    expect(row).toMatchObject({
      externalId: c.commentId,
      sourceExternalId: c.postId,
      body: 'buy now',
      authorExternalId: expect.stringMatching(/^\d+$/),
      authorName: expect.stringMatching(/^User \d+$/),
      permalink: `https://www.facebook.com/${c.commentId}`,
      platformState: 'visible',
      isOwnAccount: false,
      connectionStatus: 'active',
    });
    expect(events).toEqual([{ platform: 'facebook', lagMs: 0, outcome: 'created' }]);
  });

  it('flags comments written by the Page itself', async () => {
    const c = graph.addComment(pageId, { authorId: pageId, message: 'thanks!' });
    const r = await run(payload(c, 'created'));
    expect((await store.load(t, r.commentId as string))?.isOwnAccount).toBe(true);
  });

  it('a duplicate created job stores one row', async () => {
    const c = graph.addComment(pageId);
    const a = await run(payload(c, 'created'));
    tick();
    const b = await run(payload(c, 'created'));
    expect(b.commentId).toBe(a.commentId);
    expect(await rowsFor(c.commentId)).toHaveLength(1);
  });

  it('updated event after an edit stores the new body; history (moderation_action rows) untouched', async () => {
    const c = graph.addComment(pageId, { message: 'v1' });
    const { commentId } = await run(payload(c, 'created'));
    await pool.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, request_key, status, completed_at)
       VALUES ($1, $2, $3, $4, 'hide', 'system', $5, 'applied', now())`,
      [t.organizationId, t.brandId, t.connectionId, commentId, `rk-${randomUUID()}`],
    );
    const history = async () =>
      (
        await pool.query(
          'SELECT id, kind, status, updated_at FROM moderation_action WHERE comment_id = $1',
          [commentId],
        )
      ).rows;
    const before = await history();
    graph.editComment(c.commentId, 'v2 edited');
    tick();
    const r = await run(payload(c, 'updated'));
    expect(r).toMatchObject({ outcome: 'updated', commentId });
    expect((await store.load(t, commentId as string))?.body).toBe('v2 edited');
    expect(await history()).toEqual(before);
  });

  it('deleted event marks deleted without any Graph call', async () => {
    const c = graph.addComment(pageId);
    const { commentId } = await run(payload(c, 'created'));
    graph.removeComment(c.commentId);
    const calls = graph.calls().length;
    tick();
    const r = await run(payload(c, 'deleted'));
    expect(r).toMatchObject({ outcome: 'deleted', commentId });
    expect(graph.calls()).toHaveLength(calls);
    expect((await store.load(t, commentId as string))?.platformState).toBe('deleted');
  });

  it('a comment gone before fetch is reported as gone and not stored', async () => {
    const c = graph.addComment(pageId);
    graph.removeComment(c.commentId);
    const r = await run(payload(c, 'created'));
    expect(r).toMatchObject({ outcome: 'gone', commentId: null });
    expect(await rowsFor(c.commentId)).toHaveLength(0);
    expect(events.map((e) => e.outcome)).toEqual(['gone']);
  });

  it('remove processed first, then a late created job -> stays deleted', async () => {
    const c = graph.addComment(pageId, { message: 'spam' });
    const d = await run(payload(c, 'deleted'));
    expect(d.outcome).toBe('deleted');
    tick();
    // FakeGraph still returns the comment: a stale read of a comment already removed.
    const r = await run(payload(c, 'created'));
    expect(r.commentId).toBe(d.commentId);
    expect(await store.load(t, r.commentId as string)).toMatchObject({
      platformState: 'deleted',
      body: 'spam',
    });
    expect(await rowsFor(c.commentId)).toHaveLength(1);
  });

  it('remove processed while an earlier edit fetch is in flight -> stays deleted', async () => {
    const c = graph.addComment(pageId, { message: 'v1' });
    const { commentId } = await run(payload(c, 'created'));
    graph.editComment(c.commentId, 'v2');
    tick();
    const held = holdNextResponse();
    const editJob = run(payload(c, 'updated'));
    await held.reached;
    tick();
    await run(payload(c, 'deleted'));
    tick();
    held.release();
    expect(await editJob).toMatchObject({ outcome: 'stale', commentId });
    expect((await store.load(t, commentId as string))?.platformState).toBe('deleted');
  });

  it('a stale fetch landing after a newer one never overwrites it', async () => {
    const c = graph.addComment(pageId, { message: 'v1' });
    const { commentId } = await run(payload(c, 'created'));
    graph.editComment(c.commentId, 'v2');
    tick();
    const held = holdNextResponse();
    const older = run(payload(c, 'updated'));
    await held.reached; // its response (v2) is captured
    graph.editComment(c.commentId, 'v3');
    tick();
    expect(await run(payload(c, 'updated'))).toMatchObject({ outcome: 'updated' });
    tick(); // the older response lands later in wall-clock time too
    held.release();
    expect(await older).toMatchObject({ outcome: 'stale' });
    expect((await store.load(t, commentId as string))?.body).toBe('v3');
  });

  it('records ingest lag from platformEventSec', async () => {
    const c = graph.addComment(pageId);
    await run(payload(c, 'created', nowMs - 5_000));
    expect(events).toEqual([{ platform: 'facebook', lagMs: 5_000, outcome: 'created' }]);
    events.length = 0;
    // A platform clock ahead of ours is clamped to 0.
    await run(payload(graph.addComment(pageId), 'created', nowMs + 60_000));
    expect(events[0]).toMatchObject({ lagMs: 0 });
  });

  it('an observer that throws never fails the job', async () => {
    const throwing = ingestCommentJob({
      ...deps,
      observer: {
        onIngested: () => {
          throw new Error('boom');
        },
      },
    });
    const c = graph.addComment(pageId);
    await expect(
      throwing.handle(jobCtx(), INGEST_JOB.payload.parse(payload(c, 'created'))),
    ).resolves.toMatchObject({ outcome: 'created' });
  });

  it('unknown connection -> non-retryable connection_not_found, nothing stored', async () => {
    const c = graph.addComment(pageId);
    const err = await run(payload(c, 'created'), { ...scope, connectionId: randomUUID() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JobError);
    expect(err).toMatchObject({ kind: 'non_retryable', code: 'connection_not_found' });
    expect(await rowsFor(c.commentId)).toHaveLength(0);
  });

  it('connection needing reconnect -> throws auth_expired (job layer dead-letters needs_reconnection)', async () => {
    const c = graph.addComment(pageId);
    await ctx.c.query(
      "UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_access_rejected' WHERE id = $1",
      [t.connectionId],
    );
    try {
      const err = await run(payload(c, 'created')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err).toMatchObject({ kind: 'auth_expired', reauthorize: true });
      expect(classifyFailure(err).kind).toBe('needs_reconnection');
      expect(await rowsFor(c.commentId)).toHaveLength(0);
    } finally {
      await ctx.c.query(
        "UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1",
        [t.connectionId],
      );
    }
  });
});
