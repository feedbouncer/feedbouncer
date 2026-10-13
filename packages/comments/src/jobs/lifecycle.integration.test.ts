// Runs the lifecycle handler directly over the real connector runtime (Pg
// directory + vault), with FakeGraph as the platform.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import {
  ConnectorRegistry,
  ConnectorRuntime,
  MemoryRefreshLock,
  PgConnectionDirectory,
  PgCredentialVault,
  TokenManager,
  createSafeHttp,
  memoryBudget,
  type Connector,
} from '@feedbouncer/connectors';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector, INSTAGRAM_PAGE_FIELDS } from '@feedbouncer/connector-instagram';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { connectionLifecycleJob } from './lifecycle.js';
import { LIFECYCLE_JOB, type LifecyclePayload } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const lines: string[] = [];
const log = createLogger('comments-lifecycle-test', 'info', (l) => lines.push(l));

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let graph: FakeGraph;
let creds: CredentialStore;
let directory: PgConnectionDirectory;
let job: ReturnType<typeof connectionLifecycleJob>;

const jobCtx = (scope: ConnectionScope, attempt = 1): JobContext => ({
  scope,
  platform: 'facebook',
  jobType: LIFECYCLE_JOB.type,
  ledgerId: randomUUID(),
  attempt,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log,
});
const run = (scope: ConnectionScope, op: LifecyclePayload['op'], attempt = 1) =>
  job.handle(
    jobCtx(scope, attempt),
    LIFECYCLE_JOB.payload.parse({ op, nonce: `${scope.connectionId}:1` }),
  );
const secretCount = async (scope: ConnectionScope) =>
  Number(
    (
      await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM connection_secret WHERE connection_id = $1',
        [scope.connectionId],
      )
    ).rows[0]!.n,
  );

/** A tenant whose connection is a FakeGraph Page with a stored token and webhook secret. */
async function connectedPage(): Promise<{
  scope: ConnectionScope;
  pageId: string;
  userId: string;
}> {
  const t = await seedTenant(ctx.c, `lc-${randomBytes(4).toString('hex')}`);
  const scope = {
    organizationId: t.organizationId,
    brandId: t.brandId,
    connectionId: t.connectionId,
  };
  const page = graph.addPage(graph.addUser('Dana').userId, { name: 'Shop' });
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    page.pageId,
    t.connectionId,
  ]);
  await creds.put(scope, 'access_token', new Secret(page.pageToken), null);
  await creds.put(scope, 'webhook_secret', new Secret('whsec-0123456789abcdef'), null);
  return { scope, pageId: page.pageId, userId: t.userId };
}

async function disconnected() {
  const c = await connectedPage();
  await run(c.scope, 'setup');
  expect(await directory.disconnect(c.scope, c.userId)).toBe(true);
  return c;
}

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-lifecycle-test',
    onIdleError: () => {},
  });
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111' });
  creds = new CredentialStore(pool, testKeyring(['k1']));
  const meta = {
    appId: '111',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  };
  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(meta));
  registry.register(createInstagramConnector({ meta }));
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: graph.fetch.bind(graph) });
  directory = new PgConnectionDirectory(pool);
  const vault = new PgCredentialVault(creds, pool, log);
  const clock = { now: () => Date.now() };
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
  job = connectionLifecycleJob({ runtime, log });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(() => {
  lines.length = 0;
});

const finished = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === 'connection.teardown_finished');

describe('connection lifecycle job', () => {
  it('setup subscribes the Page', async () => {
    const { scope, pageId } = await connectedPage();
    expect(graph.subscribed(pageId)).toBe(false);
    await run(scope, 'setup');
    expect(graph.subscribed(pageId)).toBe(true);
  });

  it('setup failures propagate so the job retries', async () => {
    const { scope } = await connectedPage();
    graph.failNext(2);
    await expect(run(scope, 'setup')).rejects.toMatchObject({ kind: 'transient' });
  });

  it('teardown unsubscribes, then deletes the stored secrets', async () => {
    const { scope, pageId } = await disconnected();
    expect(await secretCount(scope)).toBe(2);
    await run(scope, 'teardown');
    expect(graph.subscribed(pageId)).toBe(false);
    expect(await secretCount(scope)).toBe(0);
    expect(finished()).toEqual([
      expect.objectContaining({ connectionId: scope.connectionId, unsubscribed: true }),
    ]);
  });

  it('a transient Graph error retries with the secrets kept, until the last attempt', async () => {
    const { scope, pageId } = await disconnected();
    graph.failNext(2);
    await expect(run(scope, 'teardown', 1)).rejects.toMatchObject({ kind: 'transient' });
    expect(await secretCount(scope)).toBe(2);
    expect(finished()).toEqual([]);

    graph.failNext(2);
    const last = LIFECYCLE_JOB.policy.maxAttempts;
    await expect(run(scope, 'teardown', last)).rejects.toMatchObject({ kind: 'transient' });
    expect(await secretCount(scope)).toBe(0);
    expect(graph.subscribed(pageId)).toBe(true);
    expect(finished()).toEqual([
      expect.objectContaining({ connectionId: scope.connectionId, unsubscribed: false }),
    ]);
  });

  it('a revoked token counts as unsubscribed and the secrets are deleted', async () => {
    const { scope, pageId } = await disconnected();
    graph.revokePageToken(pageId);
    await run(scope, 'teardown');
    expect(await secretCount(scope)).toBe(0);
    expect(finished()).toEqual([expect.objectContaining({ unsubscribed: true })]);
  });

  it('a connection that was reconnected before teardown ran keeps its secrets', async () => {
    const { scope, pageId } = await disconnected();
    await ctx.c.query(
      "UPDATE connection SET status = 'active', status_reason = NULL WHERE id = $1",
      [scope.connectionId],
    );
    await run(scope, 'teardown');
    expect(await secretCount(scope)).toBe(2);
    expect(graph.subscribed(pageId)).toBe(true);
    expect(finished()).toEqual([]);
  });

  it('never logs a token', async () => {
    const { scope } = await disconnected();
    graph.failNext(2);
    await run(scope, 'teardown', LIFECYCLE_JOB.policy.maxAttempts).catch(() => undefined);
    const joined = lines.join('\n');
    for (const s of graph.issuedSecrets()) expect(joined).not.toContain(s);
  });
  it('instagram setup subscribes comments on the linked page; facebook teardown on the same page keeps it (Review Focus 1)', async () => {
    // One Page, connected both as Facebook and (through its linked account) as Instagram.
    const fb = await connectedPage();
    await run(fb.scope, 'setup');
    const fbFields = [...graph.subscribedFields(fb.pageId)];
    expect(fbFields.length).toBeGreaterThan(0);

    const igUserId = graph.addInstagramAccount(fb.pageId).igUserId;
    const ig = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'instagram', $3) RETURNING id`,
      [fb.scope.organizationId, fb.scope.brandId, igUserId],
    );
    const igScope = { ...fb.scope, connectionId: ig.rows[0]!.id };
    const pageToken = (await creds.get(fb.scope, 'access_token'))!.value.reveal();
    await creds.put(igScope, 'access_token', new Secret(pageToken), null);

    await run(igScope, 'setup');
    const merged = graph.subscribedFields(fb.pageId);
    expect([...merged].sort()).toEqual(
      [...new Set([...fbFields, ...INSTAGRAM_PAGE_FIELDS])].sort(),
    );

    // Disconnecting Facebook removes only its own fields.
    expect(await directory.disconnect(fb.scope, fb.userId)).toBe(true);
    await run(fb.scope, 'teardown');
    expect(await secretCount(fb.scope)).toBe(0);
    for (const f of INSTAGRAM_PAGE_FIELDS) expect(graph.subscribedFields(fb.pageId)).toContain(f);
    expect(graph.subscribed(fb.pageId)).toBe(true);
    expect(await secretCount(igScope)).toBe(1);
  });
});
