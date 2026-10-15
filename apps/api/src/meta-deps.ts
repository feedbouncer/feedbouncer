// The API's side of the Meta connectors (Facebook, and Instagram through
// Facebook Login): the connector stack for OAuth and webhook routing, an
// enqueue-only job producer, and the comment store and moderation actions. The
// worker runs the jobs. Everything here is null (not built) when Facebook is
// not configured, so no queue connection is opened. Instagram runs on the same
// Meta app, so it is only ever registered alongside Facebook; so does Meta Ads.
import { hostname } from 'node:os';
import type pg from 'pg';
import {
  BACKFILL_JOB,
  EXECUTE_JOB,
  INGEST_JOB,
  LIFECYCLE_JOB,
  ModerationActions,
  PgCommentStore,
  enqueueOnly,
} from '@feedbouncer/comments';
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import { createMetaAdsConnector } from '@feedbouncer/connector-meta-ads';
import {
  ConnectorRegistry,
  buildPgConnectorStack,
  systemClock,
  type PgConnectorStack,
} from '@feedbouncer/connectors';
import { createPool } from '@feedbouncer/db';
import {
  JobMetrics,
  JobProducer,
  JobRegistry,
  PgJobLedger,
  QueueSet,
  createProducerConnection,
} from '@feedbouncer/jobs';
import {
  promConnectorObserver,
  promWebhookObserver,
  type FbMetrics,
} from '@feedbouncer/observability';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { AppDeps } from './deps.js';
import type { ApiEnv } from './env.js';

export interface MetaDeps extends Pick<AppDeps, 'connectors' | 'producer' | 'comments'> {
  readonly connectors: { registry: ConnectorRegistry; stack: PgConnectorStack };
  readonly producer: JobProducer;
  readonly comments: NonNullable<AppDeps['comments']>;
  /** Closes the queue connection and the refresh-lock pool this module opened. */
  close(): Promise<void>;
}

export function buildMetaDeps(d: {
  env: ApiEnv;
  pool: pg.Pool;
  log: Logger;
  metrics: FbMetrics;
  /** Tests only: the platform double behind SafeHttp. */
  fetch?: typeof fetch;
}): MetaDeps | null {
  const { env, pool, log, metrics } = d;
  const fb = env.facebook;
  if (!fb) return null;
  const registry = new ConnectorRegistry();
  registry.register(createFacebookConnector(fb));
  if (env.instagram) registry.register(createInstagramConnector(env.instagram));
  if (env.metaAds) registry.register(createMetaAdsConnector(env.metaAds));

  const redis = createProducerConnection(env.redisUrl.href);
  redis.on('error', (err) => log.warn('redis producer connection error', errorFields(err)));
  // PgRefreshLock holds a session per refresh; it gets a small pool of its own.
  const lockPool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-api-locks',
    max: 2,
    onIdleError: (err) => log.warn('postgres lock pool idle client error', errorFields(err)),
  });
  const stack = buildPgConnectorStack({
    pool,
    lockPool,
    redis,
    redisPrefix: env.jobs.prefix,
    keys: env.encryption,
    registry,
    // One Meta app signs both platforms' webhooks and owns both OAuth clients.
    appSecrets: new Map([
      ['facebook', fb.appSecret],
      ...(env.instagram ? ([['instagram', fb.appSecret]] as const) : []),
      ...(env.metaAds ? ([['meta_ads', fb.appSecret]] as const) : []),
    ]),
    redirectUri: (p) => new URL(`/api/v1/oauth/${p}/callback`, env.publicWebUrl).href,
    log,
    workerId: `api-${hostname()}`,
    observer: promConnectorObserver(metrics),
    webhookObserver: promWebhookObserver(metrics),
    ...(d.fetch && { fetch: d.fetch }),
  });
  // Same job types and keys as the worker's registry, without handlers. Each
  // spec lists the platforms it serves, so one registration covers both.
  const jobs = new JobRegistry();
  jobs.register(enqueueOnly(INGEST_JOB));
  jobs.register(enqueueOnly(EXECUTE_JOB));
  jobs.register(enqueueOnly(LIFECYCLE_JOB));
  jobs.register(enqueueOnly(BACKFILL_JOB));
  const queues = new QueueSet({
    connection: redis,
    prefix: env.jobs.prefix,
    laneOf: jobs.laneOf(),
  });
  const producer = new JobProducer({
    ledger: new PgJobLedger(pool),
    jobs,
    connectors: registry,
    queues,
    metrics: new JobMetrics(log),
    dedupWindowMs: env.jobs.dedupWindowMs,
  });
  const store = new PgCommentStore(pool);
  const actions = new ModerationActions({
    pool,
    store,
    producer,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock: systemClock,
    log,
  });
  return {
    connectors: { registry, stack },
    producer,
    comments: { store, actions },
    async close() {
      await queues.close();
      await Promise.allSettled([redis.quit(), lockPool.end()]);
    },
  };
}
