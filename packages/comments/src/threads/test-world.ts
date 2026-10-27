// Pg stores, the real connector runtime and one FakeThreads, for the Threads poll suites.
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
} from '@feedbouncer/connectors';
import { createThreadsConnector, type ThreadsConfig } from '@feedbouncer/connector-threads';
import { FakeThreads } from '@feedbouncer/connector-threads/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { PgCommentStore } from '../store.js';
import { PgThreadsPolling } from './polling.js';

const APP = { appId: '1234567890', appSecret: 'threads-test-SECRET-0123456789' };
export const NOW_MS = Date.UTC(2026, 9, 24, 12, 0, 0);
export const DAY_MS = 86_400_000;
export const SETTINGS = { pollIntervalSec: 600, discoveryIntervalSec: 900 } as const;
export const log = createLogger('comments-threads-test', 'error', () => {});

/** Grants every call and records the consumption, so suites can bound what a pass spends. */
function recordingBudget() {
  const consumed: Record<string, number> = {};
  const budget = new RateBudget((o) => ({
    consume: async (_key, points = 1) => {
      consumed[o.keyPrefix] = (consumed[o.keyPrefix] ?? 0) + points;
      return {};
    },
    reward: async (_key, points = 1) => {
      consumed[o.keyPrefix] = (consumed[o.keyPrefix] ?? 0) - points;
      return {};
    },
    penalty: async () => ({}),
    block: async () => ({}),
    get: async () => null,
  }));
  return { budget, consumed };
}

export async function threadsWorld(label: string) {
  const db = await migratedDb();
  const pool = createPool(db.db.url, {
    applicationName: `threads-${label}`,
    onIdleError: () => {},
  });
  let t = NOW_MS;
  const clock: Clock = { now: () => t };
  const fake = new FakeThreads({ ...APP, now: () => new Date(t) });
  const cfg: ThreadsConfig = {
    appId: APP.appId,
    appSecret: new Secret(APP.appSecret),
    webhookVerifyToken: null,
    ...SETTINGS,
  };
  const connector = createThreadsConnector(cfg, { clock });
  // Conversation reads after the first `n` answer as throttled, until cleared with null.
  let conversationLimit: number | null = null;
  let conversationReads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/conversation')) {
      conversationReads++;
      if (conversationLimit !== null && conversationReads > conversationLimit)
        return Response.json({ error: { type: 'OAuthException', code: 4 } }, { status: 400 });
    }
    return fake.fetch(input, init);
  };
  const http = (c: Connector) => createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch });
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  const directory = new PgConnectionDirectory(pool);
  const vault = new PgCredentialVault(creds, pool, log);
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log,
    oauthContext: (c): OAuthContext => ({
      http: http(c),
      signal: AbortSignal.timeout(15_000),
      redirectUri: 'https://app.test/cb',
    }),
  });
  const { budget, consumed } = recordingBudget();
  const runtime = new ConnectorRuntime({
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
  const polling = new PgThreadsPolling(pool);

  const tenant = async (name: string): Promise<Tenant> => {
    const a = await seedTenant(db.c, `${label}-${name}`);
    await db.c.query('DELETE FROM connection WHERE id = $1', [a.connectionId]);
    return a;
  };
  /** An active Threads connection for a new fake account, with its tokens stored. */
  const connect = async (
    a: Pick<Tenant, 'organizationId' | 'brandId'>,
    o: { username?: string; status?: string } = {},
  ) => {
    const { userId, authCode } = fake.addUser({ username: o.username ?? 'shop' });
    const { tokens: tk } = await connector.exchangeCode(
      { code: new Secret(authCode), codeVerifier: new Secret('v') },
      {
        http: http(connector),
        signal: AbortSignal.timeout(15_000),
        redirectUri: 'https://app.test/cb',
      },
    );
    const r = await db.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, 'threads', $3, $4) RETURNING id`,
      [a.organizationId, a.brandId, userId, o.status ?? 'active'],
    );
    const scope: ConnectionScope = {
      organizationId: a.organizationId,
      brandId: a.brandId,
      connectionId: r.rows[0]!.id,
    };
    await creds.put(scope, 'access_token', tk.accessToken, tk.accessTokenExpiresAt);
    await creds.put(scope, 'refresh_token', tk.refreshToken!, tk.refreshTokenExpiresAt);
    return { scope, userId };
  };

  /** A bare Threads connection row (no tokens, no fake account). */
  const insertConnection = async (
    a: Pick<Tenant, 'organizationId' | 'brandId'>,
    externalAccountId: string,
    status = 'active',
  ): Promise<ConnectionScope> => {
    const r = await db.c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, 'threads', $3, $4) RETURNING id`,
      [a.organizationId, a.brandId, externalAccountId, status],
    );
    return { organizationId: a.organizationId, brandId: a.brandId, connectionId: r.rows[0]!.id };
  };

  const jobCtx = (scope: ConnectionScope): JobContext => ({
    scope,
    platform: 'threads',
    jobType: 'threads_poll',
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
        body: string;
        platform_state: string;
        ingest_origin: string;
        is_own_account: boolean;
        posted_at: Date;
        source_external_id: string;
      }>(
        `SELECT c.external_id, c.parent_external_id, c.parent_comment_id, c.body, c.platform_state,
                c.ingest_origin, c.is_own_account, c.posted_at, s.external_id AS source_external_id
           FROM comment c JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
          ORDER BY c.posted_at DESC, c.external_id`,
        ids(s),
      )
    ).rows;
  const sourcePoll = async (s: ConnectionScope, externalId: string) =>
    (
      await pool.query<{
        high_water_at: Date | null;
        resume_cursor: string | null;
        last_error_code: string | null;
        unavailable_since: Date | null;
        next_poll_at: Date;
        last_full_scan_at: Date | null;
        owner_verified: boolean | null;
      }>(
        `SELECT sp.high_water_at, sp.resume_cursor, sp.last_error_code, sp.unavailable_since,
                sp.next_poll_at, sp.last_full_scan_at, sp.owner_verified
           FROM source_poll sp JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
          WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3 AND s.external_id = $4`,
        [...ids(s), externalId],
      )
    ).rows[0];
  const pending = async (s: ConnectionScope) =>
    (
      await pool.query<{ external_id: string; source_external_id: string; attempts: number }>(
        `SELECT external_id, source_external_id, attempts FROM threads_pending_reply
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 ORDER BY external_id`,
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
    consumed,
    now: () => new Date(t),
    advance: (ms: number) => void (t += ms),
    /** Throttle conversation reads once `n` more have been served; null lifts it. */
    throttleConversationAfter: (n: number | null) => {
      conversationLimit = n === null ? null : conversationReads + n;
    },
    tenant,
    connect,
    insertConnection,
    jobCtx,
    comments,
    sourcePoll,
    pending,
    connectionRow,
    close: async () => {
      await pool.end();
      await db.close();
    },
  };
}

export type ThreadsWorld = Awaited<ReturnType<typeof threadsWorld>>;
