// Runs the discovery handler over the Pg tracking store and the real connector
// runtime (Pg directory + vault), with one FakeGraph as Facebook, Instagram and Ads.
import { createHash, randomUUID } from 'node:crypto';
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
import { adDiscoveryJob } from './discovery.js';
import { DISCOVERY_JOB } from './specs.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
const log = createLogger('comments-discovery-test', 'error', () => {});

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
let graph: FakeGraph;
let userId: string;
let pageId: string;
let igUserId: string;
let adAccountId: string;
let fbScope: ConnectionScope;
let igScope: ConnectionScope;
let adsScope: ConnectionScope;
let adsScopeB: ConnectionScope;
let job: ReturnType<typeof adDiscoveryJob>;
let deps: Parameters<typeof adDiscoveryJob>[0];
let makeDeps: () => Parameters<typeof adDiscoveryJob>[0];
let nowMs = Date.UTC(2026, 9, 14, 12, 0, 0);
const clock: Clock = { now: () => nowMs };

const jobCtx = (scope: ConnectionScope): JobContext => ({
  scope,
  platform: 'meta_ads',
  jobType: DISCOVERY_JOB.type,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(60_000),
  log,
});
const run = (bucket = 1, scope: ConnectionScope = adsScope) =>
  job.handle(jobCtx(scope), DISCOVERY_JOB.payload.parse({ bucket }));

const org = (s: ConnectionScope) => [s.organizationId, s.brandId];
const count = async (table: string, s: ConnectionScope = adsScope) =>
  Number(
    (
      await pool.query(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1 AND brand_id = $2`,
        org(s),
      )
    ).rows[0].n,
  );
const linkCount = async () =>
  Number(
    (
      await pool.query(
        `SELECT count(*) AS n FROM meta_ad_source
          WHERE organization_id = $1 AND brand_id = $2 AND unlinked_at IS NULL`,
        org(adsScope),
      )
    ).rows[0].n,
  );
const checkOf = async (adId: string) =>
  (
    await pool.query<{
      deleted_at: Date | null;
      status_checked_at: Date | null;
      name: string | null;
    }>(
      `SELECT deleted_at, status_checked_at, name FROM meta_ad
        WHERE organization_id = $1 AND brand_id = $2 AND external_id = $3`,
      [...org(adsScope), adId],
    )
  ).rows[0]!;
const resolutions = async (s: ConnectionScope = adsScope) =>
  (
    await pool.query<{ facebook: string; instagram: string }>(
      `SELECT facebook_resolution AS facebook, instagram_resolution AS instagram
         FROM meta_ad WHERE organization_id = $1 AND brand_id = $2`,
      org(s),
    )
  ).rows;
const resolutionOf = async (adId: string) =>
  (
    await pool.query<{ facebook: string; instagram: string }>(
      `SELECT facebook_resolution AS facebook, instagram_resolution AS instagram
         FROM meta_ad WHERE organization_id = $1 AND brand_id = $2 AND external_id = $3`,
      [...org(adsScope), adId],
    )
  ).rows[0];
const activeOf = async (adId: string) =>
  (
    await pool.query<{ active: boolean }>(
      'SELECT active FROM meta_ad WHERE organization_id = $1 AND brand_id = $2 AND external_id = $3',
      [...org(adsScope), adId],
    )
  ).rows[0]?.active;
const statusOf = async (s: ConnectionScope) =>
  (
    await pool.query<{ status: string }>(
      'SELECT status FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
      [...org(s), s.connectionId],
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
  pool = createPool(ctx.db.url, {
    applicationName: 'comments-discovery-test',
    onIdleError: () => {},
  });
  a = await seedTenant(ctx.c, 'disc-a');
  b = await seedTenant(ctx.c, 'disc-b');
  await ctx.c.query('DELETE FROM connection WHERE id = ANY($1::uuid[])', [
    [a.connectionId, b.connectionId],
  ]);

  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111', clock: () => nowMs });
  ({ userId } = graph.addUser('Dana'));
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

  const connect = async (t: Tenant, platform: string, ext: string, token: string) => {
    const r = await ctx.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [t.organizationId, t.brandId, platform, ext],
    );
    const scope = {
      organizationId: t.organizationId,
      brandId: t.brandId,
      connectionId: r.rows[0]!.id,
    };
    await creds.put(scope, 'access_token', new Secret(token), null);
    return scope;
  };
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  fbScope = await connect(a, 'facebook', pageId, page.pageToken);
  igScope = await connect(a, 'instagram', igUserId, page.pageToken);
  adsScope = await connect(a, 'meta_ads', adAccountId, userToken);
  adsScopeB = await connect(b, 'meta_ads', adAccountId, userToken);

  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(meta, { clock }));
  registry.register(createInstagramConnector({ meta }, { clock }));
  registry.register(adsConnector);
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
  // The budget runs on wall-clock time, so every test gets a fresh one.
  makeDeps = () => ({
    runtime: new ConnectorRuntime({
      registry,
      directory,
      vault,
      tokens,
      budget: memoryBudget(),
      clock,
      log,
      http,
    }),
    directory,
    tracking: new PgAdTracking(pool, new PgCommentStore(pool)),
    clock,
  });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  deps = makeDeps();
  job = adDiscoveryJob(deps);
  for (const t of [a, b]) {
    await ctx.c.query('DELETE FROM source WHERE organization_id = $1 AND brand_id = $2', [
      t.organizationId,
      t.brandId,
    ]);
    await ctx.c.query('DELETE FROM meta_ad WHERE organization_id = $1 AND brand_id = $2', [
      t.organizationId,
      t.brandId,
    ]);
    await ctx.c.query('DELETE FROM meta_ad_listing WHERE organization_id = $1 AND brand_id = $2', [
      t.organizationId,
      t.brandId,
    ]);
    await ctx.c.query(
      `UPDATE connection SET status = 'active' WHERE organization_id = $1 AND brand_id = $2`,
      [t.organizationId, t.brandId],
    );
  }
  graph.removeAds(adAccountId);
});

describe('ad discovery job', () => {
  it('tracks active ads on both platforms and pages through 250 ads', async () => {
    for (let i = 0; i < 248; i++)
      graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    const shared = graph.addDarkPost(pageId).postId;
    const { mediaId: igMedia } = graph.addIgComment(igUserId);
    graph.addAd(adAccountId, { storyId: shared, igMediaId: igMedia, igUserId });
    graph.addAd(adAccountId, { storyId: shared }); // same post, second ad
    graph.addAd(adAccountId, {
      status: 'PAUSED',
      storyId: graph.addDarkPost(pageId).postId,
    });
    const r = await run();
    expect(r).toMatchObject({ listed: 250, complete: true });
    expect(await count('meta_ad')).toBe(250);
    expect(await count('source_poll')).toBe(250); // 249 fb posts + 1 ig media
  });

  it('records unresolved reasons without failing and retries pending IG media next cycle', async () => {
    const { adId } = graph.addAd(adAccountId, { igUserId }); // media id lagging
    graph.addAd(adAccountId, {}); // no post
    graph.addAd(adAccountId, { raw: { id: '7', effective_object_story_id: '../me/accounts' } });
    await run();
    expect(await resolutions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instagram: 'instagram_media_pending' }),
        expect.objectContaining({ facebook: 'no_post' }),
        expect.objectContaining({ facebook: 'invalid_platform_id' }),
      ]),
    );
    graph.setAdCreative(adId, { igMediaId: graph.addIgComment(igUserId).mediaId });
    await run(2);
    expect(await resolutionOf(adId)).toMatchObject({ instagram: 'linked' });
  });

  it('retires an ad that stops being active, only after a complete listing', async () => {
    for (let i = 0; i < 150; i++)
      graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    graph.setAdStatus(adId, 'PAUSED');
    nowMs += 60_000;
    graph.failNext(2, undefined, 1); // second page fails: truncated listing
    await expect(run(2)).rejects.toBeDefined();
    expect(await activeOf(adId)).toBe(true);
    nowMs += 60_000;
    await run(3);
    expect(await activeOf(adId)).toBe(false);
  });

  it.each(['status', 'gone'] as const)(
    'an ad deleted on Meta is marked deleted_at after the next complete listing (%s)',
    async (mode) => {
      const { adId } = graph.addAd(adAccountId, {
        name: 'Doomed',
        storyId: graph.addDarkPost(pageId).postId,
      });
      await run(1);
      expect(await checkOf(adId)).toMatchObject({ name: 'Doomed', deleted_at: null });
      graph.deleteAd(adId, mode);
      nowMs += 60_000;
      expect(await run(2)).toMatchObject({ retired: 1, checked: 1, deleted: 1 });
      expect(await checkOf(adId)).toMatchObject({
        name: 'Doomed',
        deleted_at: new Date(nowMs),
        status_checked_at: new Date(nowMs),
      });
      nowMs += 60_000;
      expect(await run(3)).toMatchObject({ checked: 0, deleted: 0 });
    },
  );

  it('a paused ad is retired but not marked deleted', async () => {
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    graph.setAdStatus(adId, 'PAUSED');
    nowMs += 60_000;
    expect(await run(2)).toMatchObject({ retired: 1, checked: 1, deleted: 0 });
    expect(await activeOf(adId)).toBe(false);
    expect(await checkOf(adId)).toMatchObject({
      deleted_at: null,
      status_checked_at: new Date(nowMs),
    });
  });

  it('a throttled lookup leaves the ad unchecked and the job succeeds', async () => {
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    graph.setAdStatus(adId, 'PAUSED');
    nowMs += 60_000;
    graph.throttleNext(80004, 2, { afterCalls: 1 });
    expect(await run(2)).toMatchObject({ retired: 1, checked: 0, deleted: 0, complete: true });
    expect((await checkOf(adId)).status_checked_at).toBeNull();
  });

  it('a page connected only in another tenant yields page_not_connected', async () => {
    const { postId } = graph.addDarkPost(pageId);
    graph.addAd(adAccountId, { storyId: postId });
    const before = await count('source', fbScope);
    const r = await run(1, adsScopeB);
    expect(r).toMatchObject({ listed: 1, linked: 0, complete: true });
    expect(await resolutions(adsScopeB)).toEqual([
      expect.objectContaining({ facebook: 'page_not_connected' }),
    ]);
    expect(await count('source', adsScopeB)).toBe(0);
    expect(await count('source', fbScope)).toBe(before);
    expect(await count('source_poll', fbScope)).toBe(0);
  });

  it('80004 defers the job and retires nothing', async () => {
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    graph.throttleNext(80004, 5);
    const err = await run(2).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'rate_limited' });
    expect(await activeOf(adId)).toBe(true);
  });

  it('rerunning the same bucket is idempotent', async () => {
    graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    await run(1);
    expect(await count('meta_ad')).toBe(1);
    expect(await linkCount()).toBe(1);
    expect(await count('source_poll')).toBe(1);
  });

  it('does not guess the instagram account when Meta omits it', async () => {
    graph.addAd(adAccountId, { igMediaId: '17900000000000777' });
    const r = await run();
    expect(r).toMatchObject({
      listed: 1,
      linked: 0,
      unresolved_instagram_account_not_connected: 1,
    });
    expect(await resolutions()).toEqual([
      expect.objectContaining({ instagram: 'instagram_account_not_connected' }),
    ]);
    expect(await count('source_poll', igScope)).toBe(0);
  });

  it('stops at the cap, reports incomplete and retires nothing', async () => {
    const { adId } = graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    await run(1);
    graph.setAdStatus(adId, 'PAUSED');
    for (let i = 0; i < 150; i++)
      graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    nowMs += 60_000;
    const capped = adDiscoveryJob({ ...deps, maxAdsPerAccount: 100 });
    const r = await capped.handle(jobCtx(adsScope), { bucket: 2 });
    expect(r).toMatchObject({ listed: 100, complete: false, retired: 0 });
    expect(await activeOf(adId)).toBe(true);
    // The next job resumes after the first page and completes the listing.
    nowMs += 60_000;
    const rest = await job.handle(jobCtx(adsScope), { bucket: 3 });
    expect(rest).toMatchObject({ listed: 50, complete: true, retired: 1 });
    expect(await activeOf(adId)).toBe(false);
  });

  // Last: the revoked grant stays revoked in the shared FakeGraph.
  it('lost ad access flags the meta_ads connection reconnect_required and leaves FB/IG active', async () => {
    graph.revokeAdAccountAccess(userId, adAccountId, 200);
    await expect(run()).rejects.toMatchObject({ kind: 'auth_expired' });
    expect(await statusOf(adsScope)).toBe('reconnect_required');
    expect(await statusOf(fbScope)).toBe('active');
    expect(await statusOf(igScope)).toBe('active');
  });
});
