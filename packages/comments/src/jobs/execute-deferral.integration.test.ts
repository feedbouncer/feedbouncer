// The execute job records when a throttled action will be retried (deferred_until,
// deferred_code) so the comments list can show it; settling clears both.
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
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { ModerationActions } from '../actions.js';
import { ingestCommentJob } from './ingest.js';
import { executeActionJob } from './execute.js';
import { recordDeferral } from './settle.js';
import { EXECUTE_JOB, INGEST_JOB } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-execute-deferral-test', 'error', () => {});

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
let actions: ModerationActions;
let commentRowId: string;

const facebookMeta = () => ({
  appId: '111',
  appSecret: new Secret(APP_SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
});

const jobCtx = (jobType: string = EXECUTE_JOB.type): JobContext => ({
  scope,
  platform: 'facebook',
  jobType,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log,
});

/** A runtime with its own rate budget, so a throttle on one does not block the next. */
function makeRuntime(): ConnectorRuntime {
  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(facebookMeta(), { clock }));
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
  return new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget: memoryBudget(),
    clock,
    log,
    http,
  });
}

const producer = {
  enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
};
const run = (runtime: ConnectorRuntime, actionId: string) =>
  executeActionJob({ pool, runtime, log, producer, clock }).handle(
    jobCtx(),
    EXECUTE_JOB.payload.parse({ actionId }),
  );

const deferralOf = async (id: string) =>
  (
    await pool.query<{ status: string; deferred_until: Date | null; deferred_code: string | null }>(
      'SELECT status, deferred_until, deferred_code FROM moderation_action WHERE id = $1',
      [id],
    )
  ).rows[0]!;

async function requestHide(): Promise<string> {
  const r = await actions.request({
    scope: t,
    commentId: commentRowId,
    kind: 'hide',
    actor: { type: 'user', userId: t.userId },
    requestKey: `rk-${randomUUID()}`,
  });
  if (r.status !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(r)}`);
  return r.action.id;
}

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-execute-deferral-test',
    onIdleError: () => {},
  });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

beforeEach(async () => {
  nowMs = Date.now();
  t = await seedTenant(ctx.c, `dfr${++n}`);
  scope = { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId };
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  const { userId } = graph.addUser('Dana');
  const page = graph.addPage(userId, { name: 'Shop' });
  pageId = page.pageId;
  pageToken = page.pageToken;
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

  const store = new PgCommentStore(pool);
  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(facebookMeta()));
  actions = new ModerationActions({
    pool,
    store,
    producer,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock,
    log,
  });
  const c = graph.addComment(pageId, { message: 'spam here', createdAtMs: nowMs - 60_000 });
  const ingest = ingestCommentJob({
    runtime: makeRuntime(),
    directory: new PgConnectionDirectory(pool),
    store,
    clock,
  });
  const r = await ingest.handle(
    jobCtx(INGEST_JOB.type),
    INGEST_JOB.payload.parse({
      sourceExternalId: c.postId,
      commentExternalId: c.commentId,
      event: 'created',
      platformEventSec: Math.floor(nowMs / 1000),
      changeId: '0123456789abcdef',
    }),
  );
  commentRowId = r.commentId as string;
});

describe('moderation execute job: visible deferral', () => {
  it('a rate-limited execute records deferred_until=now+retryAfter and deferred_code; a later success clears both', async () => {
    const actionId = await requestHide();
    graph.throttleNext();
    const err = await run(makeRuntime(), actionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const { retryAfterMs, code } = err as ConnectorError;
    expect(retryAfterMs).toBeGreaterThan(0);
    const deferred = await deferralOf(actionId);
    expect(deferred.status).toBe('pending');
    expect(deferred.deferred_code).toBe(code);
    expect(deferred.deferred_until!.getTime()).toBe(nowMs + retryAfterMs!);

    expect(await run(makeRuntime(), actionId)).toMatchObject({ status: 'applied' });
    expect(await deferralOf(actionId)).toEqual({
      status: 'applied',
      deferred_until: null,
      deferred_code: null,
    });
  });

  it("a deferral on another org's action id updates nothing", async () => {
    const actionId = await requestHide();
    const other = await seedTenant(ctx.c, `dfr-other${++n}`);
    await recordDeferral(
      pool,
      { organizationId: other.organizationId, brandId: other.brandId },
      actionId,
      new Date(nowMs + 60_000),
      'platform_throttled',
    );
    expect(await deferralOf(actionId)).toMatchObject({
      status: 'pending',
      deferred_until: null,
      deferred_code: null,
    });
  });

  it('a deferral never touches an action that already settled', async () => {
    const actionId = await requestHide();
    await run(makeRuntime(), actionId);
    await recordDeferral(pool, scope, actionId, new Date(nowMs + 60_000), 'platform_throttled');
    expect(await deferralOf(actionId)).toMatchObject({
      status: 'applied',
      deferred_until: null,
      deferred_code: null,
    });
  });
});
