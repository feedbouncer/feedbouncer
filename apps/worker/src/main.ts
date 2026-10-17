import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import {
  EmailReconnectNotifier,
  NotifyingConnectionDirectory,
  PgAdTracking,
  PgCommentStore,
  PollScheduler,
} from '@feedbouncer/comments';
import {
  PgSyncRecorder,
  buildPgConnectorStack,
  systemClock,
  type ConnectionDirectory,
} from '@feedbouncer/connectors';
import { ReviewModeSweeper } from '@feedbouncer/actions';
import { CLASSIFIER_LANE } from '@feedbouncer/classifier';
import { POLICY_LANE, PgPolicyPreviewStore } from '@feedbouncer/policies';
import { createPool, runJobOnce } from '@feedbouncer/db';
import {
  JobMetrics,
  JobProducer,
  JobRegistry,
  JobWorkers,
  PgJobLedger,
  QueueSet,
  createProducerConnection,
  createWorkerConnection,
} from '@feedbouncer/jobs';
import { createSmtpMailer } from '@feedbouncer/mailer';
import {
  promConnectorObserver,
  promIngestObserver,
  promWebhookObserver,
  startMetricsServer,
} from '@feedbouncer/observability';
import { reportKeyCoverage } from '@feedbouncer/secrets';
import {
  createLogger,
  errorFields,
  installCrashHandlers,
  logConfigurationLoaded,
  onShutdown,
  startHealthServer,
  waitUntil,
  writeStartupConfigError,
} from '@feedbouncer/service-runtime';
import { startAlertLoops } from './alerts.js';
import { loadWorkerEnv, type WorkerEnv } from './env.js';
import { startReportLoops } from './reports.js';
import { SYSTEM_QUEUE, createProcessor } from './processor.js';
import { buildConnectorRegistry, buildJobRegistry } from './registries.js';
import { reportStartupFailure } from './startup.js';
import { buildWorkerTelemetry } from './telemetry.js';

let env: WorkerEnv;
const configWarnings: string[] = [];
try {
  env = loadWorkerEnv(process.env, { warn: (m) => configWarnings.push(m) });
} catch (err) {
  writeStartupConfigError('worker', err);
  process.exit(1);
}

const PREVIEW_PRUNE_INTERVAL_MS = 3_600_000;
const REVIEW_SWEEP_INTERVAL_MS = 300_000;

const log = createLogger('worker', env.logLevel);
installCrashHandlers(log);
for (const w of configWarnings) log.warn(w, { appEnv: env.appEnv });
logConfigurationLoaded(log, env);
log.info('policy.config', {
  provider: env.policy.model?.provider ?? 'none',
  model: env.policy.model?.model ?? 'none',
  baseUrlHost: env.policy.model?.baseUrl?.host ?? null,
});
log.info('classifier.config', {
  provider: env.classifier.model?.provider ?? 'none',
  model: env.classifier.model?.model ?? 'none',
  baseUrlHost: env.classifier.model?.baseUrl?.host ?? null,
  languages: env.classifier.languages.length,
});
try {
  const workerId = hostname();
  const connectors = buildConnectorRegistry(env);
  // One Postgres client per concurrent job on a registered platform, capped.
  const jobConsumerConnections = Math.min(
    32,
    connectors.platforms().reduce((sum, p) => sum + env.jobs.concurrency[p], 0),
  );
  const laneConsumerConnections = Object.values(env.jobs.laneConcurrency).reduce(
    (sum, n) => sum + n * connectors.platforms().length,
    0,
  );
  const pool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-worker',
    max: env.concurrency + 2 + jobConsumerConnections + Math.min(32, laneConsumerConnections),
    onIdleError: (err) => log.warn('postgres idle client error', errorFields(err)),
  });
  // PgRefreshLock holds a session per refresh, so it gets a small pool of its own.
  const lockPool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-worker-locks',
    max: 4,
    onIdleError: (err) => log.warn('postgres lock pool idle client error', errorFields(err)),
  });
  // Each in-flight classification or policy check holds one session for its whole provider call.
  const slotsPool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-worker-classifier-slots',
    max: Math.max(
      2,
      ((env.jobs.laneConcurrency[CLASSIFIER_LANE] ?? 0) +
        (env.jobs.laneConcurrency[POLICY_LANE] ?? 0)) *
        connectors.platforms().length,
    ),
    onIdleError: (err) => log.warn('postgres slots pool idle client error', errorFields(err)),
  });
  const ledger = new PgJobLedger(pool);
  // Tracing registers its global provider here, before any span-producing code
  // (queues, workers, connectors) is constructed.
  const telemetry = buildWorkerTelemetry({ env, pool, ledger, log });
  const redis = createWorkerConnection(env.redisUrl.href);
  const producerRedis = createProducerConnection(env.redisUrl.href);
  for (const [name, client] of [
    ['redis', redis],
    ['redis producer', producerRedis],
  ] as const) {
    client.on('error', (err) => log.warn(`${name} connection error`, errorFields(err)));
  }

  const { facebook, mail } = env;
  // Mail is only configured (and only needed) for Facebook, email alerts or weekly reports.
  const mailer = mail ? createSmtpMailer(mail.smtpUrl, mail.mailFrom) : null;
  let jobs = new JobRegistry();
  let scheduler: PollScheduler | null = null;
  let alertLoops: ReturnType<typeof startAlertLoops> = null;
  let reportLoops: ReturnType<typeof startReportLoops> = null;
  if (facebook && mail && mailer) {
    const stack = buildPgConnectorStack({
      pool,
      lockPool,
      redis: producerRedis,
      redisPrefix: env.jobs.prefix,
      keys: env.encryption,
      registry: connectors,
      // One Meta app signs both platforms' webhooks and owns both OAuth clients.
      appSecrets: new Map([
        ['facebook', facebook.appSecret],
        ...(env.instagram ? ([['instagram', facebook.appSecret]] as const) : []),
        ...(env.metaAds ? ([['meta_ads', facebook.appSecret]] as const) : []),
      ]),
      redirectUri: (p) => new URL(`/api/v1/oauth/${p}/callback`, mail.publicWebUrl).href,
      log,
      workerId,
      observer: promConnectorObserver(telemetry.metrics),
      webhookObserver: promWebhookObserver(telemetry.metrics),
      sync: new PgSyncRecorder(pool),
      wrapDirectory: (dir: ConnectionDirectory) =>
        new NotifyingConnectionDirectory(
          dir,
          new EmailReconnectNotifier({ pool, mailer, publicWebUrl: mail.publicWebUrl, log }),
          log,
        ),
    });
    const store = new PgCommentStore(pool);
    jobs = buildJobRegistry({
      runtime: stack.runtime,
      directory: stack.directory,
      store,
      pool,
      slotsPool,
      classifier: env.classifier,
      policy: env.policy,
      clock: systemClock,
      log,
      ingestObserver: promIngestObserver(telemetry.metrics),
      // The producer needs the job registry built here, so it is reached lazily.
      producer: { enqueue: (input) => producer.enqueue(input) },
      capabilities: (p) => connectors.get(p)?.capabilities,
      ...(env.adPolling ? { ads: { poll: env.adPolling.poll } } : {}),
    });
    if (env.adPolling) {
      scheduler = new PollScheduler({
        pool,
        producer: { enqueue: (input) => producer.enqueue(input) },
        tracking: new PgAdTracking(pool, store),
        clock: systemClock,
        log,
        settings: env.adPolling.scheduler,
      });
    }
  }

  const worker = new Worker(
    SYSTEM_QUEUE,
    createProcessor({
      runOnce: (key, work) => runJobOnce(pool, key, () => work()),
      workerId,
      log,
      sleep,
    }),
    { connection: redis, concurrency: env.concurrency, autorun: false },
  );
  worker.on('failed', (job, err) =>
    log.error('job failed', { jobId: job?.id ?? null, ...errorFields(err) }),
  );
  worker.on('error', (err) => log.error('worker error', errorFields(err)));
  const metrics = new JobMetrics(log, telemetry.jobSink);
  const queues = new QueueSet({
    connection: producerRedis,
    prefix: env.jobs.prefix,
    laneOf: jobs.laneOf(),
  });
  const producer = new JobProducer({
    ledger,
    jobs,
    connectors,
    queues,
    metrics,
    dedupWindowMs: env.jobs.dedupWindowMs,
  });
  const jobWorkers = new JobWorkers({
    connection: redis,
    ledger,
    producer,
    jobs,
    connectors,
    config: env.jobs,
    workerId,
    log,
    metrics,
  });
  const health = await startHealthServer({
    host: '127.0.0.1',
    port: env.healthPort,
    timeoutMs: 1_000,
    checks: {
      postgres: () => pool.query('SELECT 1'),
      redis: () => redis.ping(),
      consumer: async () => {
        if (!worker.isRunning()) throw new Error('consumer not running');
      },
      jobs: async () => {
        if (!jobWorkers.isRunning()) throw new Error('job consumers not running');
      },
    },
    onFailure: (name, err) =>
      log.debug('health check failed', { check: name, ...errorFields(err) }),
  });

  const metricsServer = await startMetricsServer({
    host: env.telemetry.metrics.host,
    port: env.telemetry.metrics.port,
    registry: telemetry.metrics.registry,
    log,
  });

  onShutdown(async () => {
    alertLoops?.stop();
    reportLoops?.stop();
    await scheduler?.stop();
    await Promise.all([worker.close(), jobWorkers.close()]);
    await queues.close();
    await health.close();
    mailer?.close();
    await Promise.allSettled([
      pool.end(),
      lockPool.end(),
      slotsPool.end(),
      redis.quit(),
      producerRedis.quit(),
    ]);
    await metricsServer?.close();
    await telemetry.tracing.shutdown();
  }, log);

  await waitUntil(() => Promise.all([pool.query('SELECT 1'), redis.ping()]), {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    attemptTimeoutMs: 2_000,
    onRetry: (attempt, err) =>
      log.warn('waiting for postgres/redis', { attempt, ...errorFields(err) }),
  });

  await reportKeyCoverage(pool, env.encryption, log);

  await jobWorkers.start();
  log.info('job consumers ready', { platforms: jobWorkers.platforms().join(',') || 'none' });
  scheduler?.start();
  const previewStore = new PgPolicyPreviewStore(pool);
  const previewPruner = setInterval(() => {
    previewStore
      .pruneExpired()
      .catch((err: unknown) => log.warn('policy preview prune failed', errorFields(err)));
  }, PREVIEW_PRUNE_INTERVAL_MS);
  previewPruner.unref();
  const reviewSweeper = new ReviewModeSweeper({ pool, clock: systemClock, log });
  const reviewModeSweep = setInterval(() => {
    reviewSweeper
      .tick()
      .catch((err: unknown) => log.warn('review mode sweep failed', errorFields(err)));
  }, REVIEW_SWEEP_INTERVAL_MS);
  reviewModeSweep.unref();
  alertLoops = startAlertLoops(
    {
      alerts: env.alerts,
      web: () => env.publicWebUrl!,
    },
    { pool, log, keys: env.encryption, mailer },
  );
  reportLoops = startReportLoops(
    { enabled: env.weeklyReports },
    { pool, log, keys: env.encryption, mailer, web: env.publicWebUrl },
  );

  worker.run().catch((err: unknown) => {
    log.error('worker stopped', errorFields(err));
    process.exit(1);
  });
  await worker.waitUntilReady();
  log.info('worker ready', { workerId, queue: SYSTEM_QUEUE, concurrency: env.concurrency });
} catch (err) {
  reportStartupFailure(log, err);
  process.exit(1);
}
