// Pg stores, the real connector runtime and one FakeTikTok serving both the
// organic (Accounts) and the Marketing API, for the TikTok poll suites.
import { randomUUID } from 'node:crypto';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
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
  type Connector,
  type OAuthContext,
  type Platform,
  type TokenSet,
} from '@feedbouncer/connectors';
import { createTikTokConnector } from '@feedbouncer/connector-tiktok';
import { createTikTokAdsConnector } from '@feedbouncer/connector-tiktok-ads';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { PgTikTokPolling } from './polling.js';
import type { TikTokPollSettings } from './ingest.js';

const APP = { appId: '7300000000000009', appSecret: 'tiktok-test-SECRET-0123456789' };
export const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
export const DAY_MS = 86_400_000;
export const log = createLogger('comments-tiktok-test', 'error', () => {});

export const SETTINGS: TikTokPollSettings = {
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
  maxPagesPerJob: 200,
};

/** Never refuses a call: these suites exercise platform throttles, not the local budget. */
const unlimitedBudget = () =>
  new RateBudget(() => ({
    consume: async () => ({}),
    reward: async () => ({}),
    penalty: async () => ({}),
    block: async () => ({}),
    get: async () => null,
  }));

type Tamper = (endpoint: string, data: Record<string, unknown>) => Record<string, unknown>;

export async function tiktokWorld(label: string, o: { wrap?: (c: Connector) => Connector } = {}) {
  const db = await migratedDb();
  const pool = createPool(db.db.url, { applicationName: `tiktok-${label}`, onIdleError: () => {} });
  let t = NOW_MS;
  const clock: Clock = { now: () => t };
  const fake = new FakeTikTok({ ...APP, now: () => new Date(t) });
  let tamper: Tamper | null = null;
  const requestIds: { path: string; requestId: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await fake.fetch(input, init);
    const path = new URL(String(input)).pathname;
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { request_id?: string } | null;
    if (body?.request_id) requestIds.push({ path, requestId: body.request_id });
    if (!tamper) return res;
    const json = (await res.json()) as { data: Record<string, unknown> };
    return Response.json(
      { ...json, data: tamper(new URL(String(input)).pathname, json.data) },
      { status: res.status },
    );
  };
  const http = (c: Connector) => createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch });
  const organic = createTikTokConnector(APP, { clock });
  const ads = createTikTokAdsConnector(APP, { clock });
  const registry = new ConnectorRegistry();
  registry.register(o.wrap ? o.wrap(organic) : organic);
  registry.register(o.wrap ? o.wrap(ads) : ads);
  const creds = new CredentialStore(pool, testKeyring(['k1']));
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
      redirectUri: 'https://app.test/cb',
    }),
  });
  const runtime = new ConnectorRuntime({
    registry,
    directory,
    vault,
    tokens,
    budget: unlimitedBudget(),
    clock,
    log,
    http,
  });
  const store = new PgCommentStore(pool);
  const polling = new PgTikTokPolling(pool);
  const oauth = (c: Connector): OAuthContext => ({
    http: http(c),
    signal: AbortSignal.timeout(15_000),
    redirectUri: 'https://app.test/cb',
  });

  const tenant = async (name: string): Promise<Tenant> => {
    const a = await seedTenant(db.c, `${label}-${name}`);
    await db.c.query('DELETE FROM connection WHERE id = $1', [a.connectionId]);
    return a;
  };
  const insertConnection = async (
    a: Pick<Tenant, 'organizationId' | 'brandId'>,
    platform: Platform,
    ext: string,
    token: string | TokenSet,
    status = 'active',
  ): Promise<ConnectionScope> => {
    const r = await db.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [a.organizationId, a.brandId, platform, ext, status],
    );
    const scope = {
      organizationId: a.organizationId,
      brandId: a.brandId,
      connectionId: r.rows[0]!.id,
    };
    if (typeof token === 'string') await creds.put(scope, 'access_token', new Secret(token), null);
    else {
      await creds.put(scope, 'access_token', token.accessToken, token.accessTokenExpiresAt);
      if (token.refreshToken)
        await creds.put(scope, 'refresh_token', token.refreshToken, token.refreshTokenExpiresAt);
    }
    return scope;
  };
  const connectTikTok = async (a: Pick<Tenant, 'organizationId' | 'brandId'>, status?: string) => {
    const { businessId, authCode } = fake.addBusinessAccount({ username: 'shop' });
    const { tokens: tk } = await organic.exchangeCode(
      { code: new Secret(authCode), codeVerifier: new Secret('v') },
      oauth(organic),
    );
    const scope = await insertConnection(a, 'tiktok', businessId, tk, status);
    return { scope, businessId };
  };
  const connectAds = async (a: Pick<Tenant, 'organizationId' | 'brandId'>, status?: string) => {
    const { advertiserId, authCode } = fake.addAdvertiser({ name: 'Acme Ads' });
    const { tokens: tk } = await ads.exchangeCode(
      { code: new Secret(authCode), codeVerifier: new Secret('v') },
      oauth(ads),
    );
    const scope = await insertConnection(a, 'tiktok_ads', advertiserId, tk, status);
    return { scope, advertiserId };
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
  const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];
  const comments = async (s: ConnectionScope) =>
    (
      await pool.query<{
        external_id: string;
        parent_external_id: string | null;
        parent_comment_id: string | null;
        platform_state: string;
        ingest_origin: string;
        posted_at: Date;
        source_external_id: string;
        source_kind: string;
      }>(
        `SELECT c.external_id, c.parent_external_id, c.parent_comment_id, c.platform_state,
                c.ingest_origin, c.posted_at, s.external_id AS source_external_id, s.kind AS source_kind
           FROM comment c JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
          ORDER BY c.posted_at DESC, c.external_id`,
        ids(s),
      )
    ).rows;
  const connectionRow = async (s: ConnectionScope) =>
    (
      await pool.query<{ status: string; status_reason: string | null; missing_scopes: string[] }>(
        `SELECT status, status_reason, missing_scopes FROM connection
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
        ids(s),
      )
    ).rows[0];
  const sourcePoll = async (s: ConnectionScope, externalId: string) =>
    (
      await pool.query<{
        high_water_at: Date | null;
        resume_cursor: string | null;
        last_error_code: string | null;
        unavailable_since: Date | null;
        next_poll_at: Date;
      }>(
        `SELECT sp.high_water_at, sp.resume_cursor, sp.last_error_code, sp.unavailable_since, sp.next_poll_at
           FROM source_poll sp JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
          WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3 AND s.external_id = $4`,
        [...ids(s), externalId],
      )
    ).rows[0];
  const connectionPoll = async (s: ConnectionScope) =>
    (
      await pool.query<{
        high_water_at: Date | null;
        pass_started_at: Date | null;
        resume_page: number | null;
        resume_cursor: string | null;
        last_full_scan_at: Date | null;
      }>(
        `SELECT high_water_at, pass_started_at, resume_page, resume_cursor, last_full_scan_at
           FROM connection_poll WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
        ids(s),
      )
    ).rows[0];

  return {
    db,
    pool,
    fake,
    registry,
    runtime,
    directory,
    store,
    polling,
    clock,
    now: () => new Date(t),
    advance: (ms: number) => void (t += ms),
    reset: () => void (t = NOW_MS),
    setTamper: (fn: Tamper | null) => void (tamper = fn),
    /** Request ids of the fake's answers on paths ending with `suffix`, oldest first. */
    requestIds: (suffix: string) =>
      requestIds.filter((r) => r.path.endsWith(suffix)).map((r) => r.requestId),
    tenant,
    connectTikTok,
    connectAds,
    insertConnection,
    jobCtx,
    comments,
    connectionRow,
    sourcePoll,
    connectionPoll,
    close: async () => {
      await pool.end();
      await db.close();
    },
  };
}

export type TikTokWorld = Awaited<ReturnType<typeof tiktokWorld>>;
export const secAgo = (w: TikTokWorld, ms: number) => Math.floor((w.clock.now() - ms) / 1000);
