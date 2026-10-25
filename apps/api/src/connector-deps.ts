// The API's side of the platform connectors: one registry composed from the
// Meta, TikTok and YouTube connectors, the connector stack for OAuth and webhook routing,
// an enqueue-only job producer, and the comment store and moderation actions.
// The worker runs the jobs. Null (not built) when no connector is configured, so
// no queue connection is opened.
import { hostname } from 'node:os';
import type pg from 'pg';
import {
  BACKFILL_JOB,
  EXECUTE_JOB,
  INGEST_JOB,
  LIFECYCLE_JOB,
  CompositeActionOutcomeObserver,
  ModerationActions,
  PgCommentStore,
  PgYouTubeBacklog,
  PgYouTubeQuotaLedger,
  PgYouTubeSettings,
  YOUTUBE_CYCLE_JOB,
  enqueueOnly,
  youtubeQuotaMeters,
} from '@feedbouncer/comments';
import {
  ACTION_RUN_ADVANCE_JOB,
  ActionStepOutcomeObserver,
  PgActionRunStore,
  SUGGESTION_BULK_JOB,
} from '@feedbouncer/actions';
import {
  CLASSIFIER_RERUN_JOB,
  ClassifierActionFallback,
  PgClassificationStore,
} from '@feedbouncer/classifier';
import {
  POLICY_PREVIEW_JOB,
  POLICY_RUN_JOB,
  PgPolicyEvaluationStore,
  PolicyActionFallback,
} from '@feedbouncer/policies';
import { PgEvaluationStore, RuleActionFallback } from '@feedbouncer/rules';
import {
  ConnectorRegistry,
  buildPgConnectorStack,
  systemClock,
  type PgConnectorStack,
  type Platform,
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
import { Secret, errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { AppDeps } from './deps.js';
import type { ApiEnv } from './env.js';
import { buildMetaDeps } from './meta-deps.js';
import { buildTikTokDeps } from './tiktok-deps.js';
import { buildYouTubeDeps } from './youtube-deps.js';

export interface ConnectorDeps extends Pick<AppDeps, 'connectors' | 'producer' | 'comments'> {
  readonly connectors: { registry: ConnectorRegistry; stack: PgConnectorStack };
  readonly producer: JobProducer;
  readonly comments: NonNullable<AppDeps['comments']>;
  /** Closes the queue connection and the refresh-lock pool this module opened. */
  close(): Promise<void>;
}

export function buildConnectorDeps(d: {
  env: ApiEnv;
  pool: pg.Pool;
  log: Logger;
  metrics: FbMetrics;
  /** Tests only: the platform double behind SafeHttp. */
  fetch?: typeof fetch;
}): ConnectorDeps | null {
  const { env, pool, log, metrics } = d;
  const meta = buildMetaDeps(env);
  const tiktok = buildTikTokDeps(env);
  const youtubeSettings = new PgYouTubeSettings(pool);
  const ledger = env.youtube
    ? new PgYouTubeQuotaLedger({
        pool,
        clock: systemClock,
        projectQuota: env.youtube.projectDailyQuota,
        projectHeadroom: env.youtube.projectHeadroomUnits,
        settings: youtubeSettings,
        log,
      })
    : null;
  const youtube = ledger ? buildYouTubeDeps(env, ledger.projectMeter()) : null;
  const connectors = [
    ...(meta?.connectors ?? []),
    ...(tiktok?.connectors ?? []),
    ...(youtube?.connectors ?? []),
  ];
  if (connectors.length === 0) return null;
  const registry = new ConnectorRegistry();
  for (const c of connectors) registry.register(c);
  const appSecrets = new Map<Platform, Secret>([
    ...(Object.entries(meta?.appSecrets ?? {}) as [Platform, Secret][]),
    ...(Object.entries(tiktok?.appSecrets ?? {}) as [Platform, Secret][]),
  ]);

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
    appSecrets,
    redirectUri: (p) => new URL(`/api/v1/oauth/${p}/callback`, env.publicWebUrl).href,
    log,
    workerId: `api-${hostname()}`,
    observer: promConnectorObserver(metrics),
    webhookObserver: promWebhookObserver(metrics),
    ...(ledger && { quotaMeters: youtubeQuotaMeters(ledger) }),
    ...(d.fetch && { fetch: d.fetch }),
  });
  // Same job types and keys as the worker's registry, without handlers. Each
  // spec lists the platforms it serves, so one registration covers them all.
  const jobs = new JobRegistry();
  jobs.register(enqueueOnly(INGEST_JOB));
  jobs.register(enqueueOnly(EXECUTE_JOB));
  jobs.register(enqueueOnly(LIFECYCLE_JOB));
  jobs.register(enqueueOnly(BACKFILL_JOB));
  jobs.register(enqueueOnly(YOUTUBE_CYCLE_JOB));
  // The lane travels with the spec, so QueueSet routes it to the classifier's queue.
  jobs.register(enqueueOnly(CLASSIFIER_RERUN_JOB));
  jobs.register(enqueueOnly(POLICY_PREVIEW_JOB));
  jobs.register(enqueueOnly(POLICY_RUN_JOB));
  // Approving a suggestion wakes its run; bulk by filter runs in the worker.
  jobs.register(enqueueOnly(ACTION_RUN_ADVANCE_JOB));
  jobs.register(enqueueOnly(SUGGESTION_BULK_JOB));
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
  // Actions the backlog settles itself (an abandoned queue, an evicted overflow) reach the same observers as the worker's.
  const youtubeBacklog = new PgYouTubeBacklog({
    pool,
    clock: systemClock,
    ...(env.youtube && { cap: env.youtube.backlogCap }),
    log,
    outcomes: new CompositeActionOutcomeObserver([
      new RuleActionFallback({ evaluations: new PgEvaluationStore(pool), log }),
      new ClassifierActionFallback({ classifications: new PgClassificationStore(pool), log }),
      new PolicyActionFallback({ evaluations: new PgPolicyEvaluationStore(pool), log }),
      new ActionStepOutcomeObserver({ runs: new PgActionRunStore(pool), producer, log }),
    ]),
  });
  const actions = new ModerationActions({
    pool,
    store,
    producer,
    capabilities: (p) => registry.get(p)?.capabilities,
    clock: systemClock,
    log,
    budgeted: youtubeBacklog,
  });
  return {
    connectors: { registry, stack },
    producer,
    comments: { store, actions, youtubeBacklog, youtubeSettings, youtubeLedger: ledger },
    async close() {
      await queues.close();
      await Promise.allSettled([redis.quit(), lockPool.end()]);
    },
  };
}
