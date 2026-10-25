// Pg stores, the real connector runtime metered by the Pg quota ledger, and one
// FakeYouTube, for the YouTube dispatch and cycle suites. Every connection is a
// new tenant on the fake's one channel; the fake's quota counters are shared, so
// suites compare deltas.
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
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
import { createYouTubeConnector } from '@feedbouncer/connector-youtube';
import { FakeYouTube } from '@feedbouncer/connector-youtube/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { CredentialStore, type ConnectionScope } from '@feedbouncer/secrets';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { ActionOutcomeObserver, CommentAppliedHook } from '../hooks.js';
import { EmailReconnectNotifier, NotifyingConnectionDirectory } from '../reconnect-notifier.js';
import { PgCommentStore } from '../store.js';
import { PgYouTubeBacklog } from './backlog.js';
import { PgYouTubeQuotaLedger } from './ledger.js';
import { planCycle, type CyclePlan, type QueuedKind } from './planner.js';
import { PgYouTubeSettings } from './settings.js';
import { budgetView } from './budget.js';
import { YouTubeNotices } from './notices.js';
import { PgYouTubeState } from './state.js';

const CLIENT = { clientId: 'yt-client-id', clientSecret: 'yt-client-SECRET-0123456789' };
export const CHANNEL = 'UC' + 'w'.repeat(22);
/** 2026-10-24 05:00 Pacific (PDT). */
export const NOW_MS = Date.parse('2026-10-24T12:00:00Z');

/** Never refuses a call: these suites exercise the quota ledger, not the rate limiter. */
const unlimitedBudget = () =>
  new RateBudget(() => ({
    consume: async () => ({}),
    reward: async () => ({}),
    penalty: async () => ({}),
    block: async () => ({}),
    get: async () => null,
  }));

export async function youtubeWorld(label: string, o: { wrap?: (c: Connector) => Connector } = {}) {
  const db = await migratedDb();
  const pool = createPool(db.db.url, {
    applicationName: `youtube-${label}`,
    onIdleError: () => {},
  });
  let t = NOW_MS;
  const clock: Clock = { now: () => t };
  const lines: { level: string; msg: string; [k: string]: unknown }[] = [];
  const log = createLogger(`comments-youtube-${label}`, 'debug', (line) => {
    lines.push(JSON.parse(line) as { level: string; msg: string });
  });
  const fake = new FakeYouTube({
    ...CLIENT,
    channel: { id: CHANNEL, title: 'Mine' },
    clock: () => t,
  });
  const http = (c: Connector) =>
    createSafeHttp({ allowedHosts: c.capabilities.apiHosts, fetch: fake.fetch });
  const connector = createYouTubeConnector(
    { clientId: CLIENT.clientId, clientSecret: new Secret(CLIENT.clientSecret) },
    { clock },
  );
  const registry = new ConnectorRegistry();
  registry.register(o.wrap ? o.wrap(connector) : connector);
  const settings = new PgYouTubeSettings(pool);
  const ledger = new PgYouTubeQuotaLedger({
    pool,
    clock,
    projectQuota: 10_000,
    projectHeadroom: 1000,
    settings,
    log,
  });
  const creds = new CredentialStore(pool, testKeyring(['k1']));
  const mailer = new MemoryMailer();
  const directory = new NotifyingConnectionDirectory(
    new PgConnectionDirectory(pool),
    new EmailReconnectNotifier({ pool, mailer, publicWebUrl: new URL('https://app.test'), log }),
    log,
  );
  const vault = new PgCredentialVault(creds, pool, log);
  const oauth = (c: Connector): OAuthContext => ({
    http: http(c),
    signal: AbortSignal.timeout(15_000),
    redirectUri: 'https://app.test/cb',
  });
  const tokens = new TokenManager({
    vault,
    directory,
    lock: new MemoryRefreshLock(),
    clock,
    log,
    oauthContext: oauth,
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
    quotaMeters: (platform, scope) => (platform === 'youtube' ? ledger.meterFor(scope) : undefined),
  });
  const outcomes: { actionId: string; status: string; code: string | null }[] = [];
  const observer: ActionOutcomeObserver = {
    onActionOutcome: async (e) =>
      void outcomes.push({ actionId: e.actionId, status: e.status, code: e.code }),
  };
  const backlog = new PgYouTubeBacklog({ pool, clock, cap: 5000, log, outcomes: observer });
  const producer = {
    enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
  };
  const store = new PgCommentStore(pool);
  const state = new PgYouTubeState(pool);
  const notices = new YouTubeNotices({
    pool,
    mailer,
    publicWebUrl: new URL('https://app.test'),
    log,
    clock,
  });
  const applied: CommentAppliedHook & { onApplied: ReturnType<typeof vi.fn> } = {
    onApplied: vi.fn(async () => {}),
  };
  const jobCtx = (scope: ConnectionScope): JobContext => ({
    scope,
    platform: 'youtube',
    jobType: 'youtube_cycle',
    ledgerId: randomUUID(),
    attempt: 1,
    isReplay: false,
    signal: AbortSignal.timeout(60_000),
    log,
  });

  const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];
  const one = async (sql: string, v: unknown[]) =>
    (await pool.query<{ id: string }>(sql, v)).rows[0]!.id;

  /** Fresh tokens from the fake, as a (re)connect stores them. */
  const giveTokens = async (scope: ConnectionScope) => {
    const { tokens: tk } = await connector.exchangeCode(
      { code: new Secret(fake.authorize()), codeVerifier: new Secret('v') },
      oauth(connector),
    );
    await creds.put(scope, 'access_token', tk.accessToken, tk.accessTokenExpiresAt);
    if (tk.refreshToken)
      await creds.put(scope, 'refresh_token', tk.refreshToken, tk.refreshTokenExpiresAt);
  };

  /** A new tenant with an active YouTube connection on the fake's channel and one video. */
  const connect = async (name: string) => {
    const tenant = await seedTenant(db.c, `yt-${label}-${name}`);
    const connectionId = await one(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
       VALUES ($1, $2, 'youtube', $3) RETURNING id`,
      [tenant.organizationId, tenant.brandId, CHANNEL],
    );
    const scope: ConnectionScope = {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      connectionId,
    };
    await giveTokens(scope);
    const videoId = fake.addVideo();
    const sourceId = await one(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1, $2, $3, 'video', $4) RETURNING id`,
      [...ids(scope), videoId],
    );
    return { scope, userId: tenant.userId, videoId, sourceId };
  };
  type Conn = Awaited<ReturnType<typeof connect>>;

  let seq = 0;
  /**
   * A comment on the fake and in our store (synced now), with a pending action on it
   * that is queued in the backlog. `fakeStatus` is the platform's state.
   */
  const queuedAction = async (
    c: Conn,
    kind: QueuedKind,
    x: {
      author?: string;
      parentExternalId?: string;
      fakeStatus?: 'published' | 'heldForReview' | 'rejected' | 'deleted';
      text?: string;
    } = {},
  ) => {
    seq += 1;
    const author = x.author ?? `UC${randomUUID().replaceAll('-', '').slice(0, 22)}`;
    const externalId = fake.addComment({
      videoId: c.videoId,
      ...(x.parentExternalId !== undefined && { parentId: x.parentExternalId }),
      authorChannelId: author,
      text: x.text ?? 'buy followers now',
      ...(x.fakeStatus !== undefined && { status: x.fakeStatus }),
    });
    const authorId = await one(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, $4, 'Viewer')
       ON CONFLICT (connection_id, external_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [...ids(c.scope), author],
    );
    const commentId = await one(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id,
                            author_id, parent_external_id, body, platform_state, posted_at,
                            platform_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'stored body', 'visible', $8, $8) RETURNING id`,
      [...ids(c.scope), c.sourceId, externalId, authorId, x.parentExternalId ?? null, new Date(t)],
    );
    const requestedAt = new Date(t + seq);
    const actionId = await one(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8) RETURNING id`,
      [...ids(c.scope), commentId, kind, c.userId, `rk-${randomUUID()}`, requestedAt],
    );
    await backlog.enqueue(c.scope, { actionId, commentId, kind, requestedAt });
    return { actionId, commentId, externalId, author };
  };

  /** The planner over the backlog, against the real (or, for dry-run, simulated) allowance. */
  const plan = async (
    scope: ConnectionScope,
    o: { simulated?: boolean } = {},
  ): Promise<CyclePlan> => {
    const s = await settings.get(scope);
    return planCycle(await backlog.loadQueued(scope), {
      affordableBatches: budgetView(await ledger.usage(scope, o)).affordableBatches,
      ownerChannelId: CHANNEL,
      protectedAuthorIds: new Set(s.protectedAuthorIds),
    });
  };

  const action = async (actionId: string) =>
    (
      await pool.query<{
        status: string;
        outcome_code: string | null;
        undo_kind: string | null;
        platform_state: string;
      }>(
        `SELECT m.status, m.outcome_code, m.undo_kind, c.platform_state
           FROM moderation_action m JOIN comment c ON c.id = m.comment_id
          WHERE m.id = $1`,
        [actionId],
      )
    ).rows[0]!;
  const queue = async (scope: ConnectionScope) =>
    (
      await pool.query<{ action_id: string; state: string; batch_id: string | null }>(
        `SELECT action_id, state, batch_id FROM youtube_action_queue
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          ORDER BY tier, requested_at, action_id`,
        ids(scope),
      )
    ).rows;
  const batches = async (scope: ConnectionScope) =>
    (
      await pool.query<{
        id: string;
        state: string;
        outcome_code: string | null;
        comment_external_ids: string[];
        action_ids: string[];
        pacific_day: string;
      }>(
        `SELECT id, state, outcome_code, comment_external_ids, action_ids::text[] AS action_ids,
                to_char(pacific_day, 'YYYY-MM-DD') AS pacific_day
           FROM youtube_write_batch
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          ORDER BY created_at, id`,
        ids(scope),
      )
    ).rows;
  const audits = async (scope: ConnectionScope) =>
    (
      await pool.query<{
        details: {
          actionId: string;
          status: string;
          outcomeCode: string | null;
          quota?: Record<string, unknown>;
        };
      }>(
        `SELECT details FROM audit_event
          WHERE organization_id = $1 AND brand_id = $2 AND action = 'comment.moderated'
          ORDER BY sequence`,
        [scope.organizationId, scope.brandId],
      )
    ).rows.map((r) => r.details);
  const comments = async (scope: ConnectionScope) =>
    (
      await pool.query<{
        external_id: string;
        parent_external_id: string | null;
        platform_state: string;
        body: string;
        source_external_id: string;
        source_kind: string;
        source_active: boolean;
      }>(
        `SELECT c.external_id, c.parent_external_id, c.platform_state, c.body,
                s.external_id AS source_external_id, s.kind AS source_kind, s.active AS source_active
           FROM comment c JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
          ORDER BY c.posted_at, c.external_id`,
        ids(scope),
      )
    ).rows;
  /** Data API calls the fake answered since `from` (an index into fake.calls). */
  const callsSince = (from: number, method?: string) =>
    fake.calls
      .slice(from)
      .filter((c) => (method ? c.method === method : !c.method.startsWith('oauth.')));

  return {
    db,
    pool,
    fake,
    clock,
    log,
    lines,
    registry,
    runtime,
    ledger,
    settings,
    backlog,
    producer,
    store,
    state,
    notices,
    mailer,
    applied,
    jobCtx,
    comments,
    outcomes,
    observer,
    now: () => new Date(t),
    advance: (ms: number) => void (t += ms),
    reset: () => {
      t = NOW_MS;
      lines.length = 0;
      outcomes.length = 0;
      producer.enqueue.mockClear();
      applied.onApplied.mockClear();
      mailer.clear();
      fake.clearFaults();
      fake.dailyLimit = 10_000_000;
    },
    /** The project-wide pause is per Pacific day and shared by every connection: clear it between tests. */
    clearPause: async () => void (await pool.query('DELETE FROM youtube_quota_pause')),
    creds,
    giveTokens,
    connect,
    queuedAction,
    plan,
    action,
    queue,
    batches,
    audits,
    callsSince,
    close: async () => {
      await pool.end();
      await db.close();
    },
  };
}

export type YouTubeWorld = Awaited<ReturnType<typeof youtubeWorld>>;
