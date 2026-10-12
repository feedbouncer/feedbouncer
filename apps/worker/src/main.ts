import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import { createPool, runJobOnce } from '@feedbouncer/db';
import {
  JobMetrics,
  JobProducer,
  JobWorkers,
  PgJobLedger,
  QueueSet,
  createProducerConnection,
  createWorkerConnection,
} from '@feedbouncer/jobs';
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
import { loadWorkerEnv, type WorkerEnv } from './env.js';
import { SYSTEM_QUEUE, createProcessor } from './processor.js';
import { buildConnectorRegistry, buildJobRegistry } from './registries.js';
import { reportStartupFailure } from './startup.js';

let env: WorkerEnv;
const configWarnings: string[] = [];
try {
  env = loadWorkerEnv(process.env, { warn: (m) => configWarnings.push(m) });
} catch (err) {
  writeStartupConfigError('worker', err);
  process.exit(1);
}

const log = createLogger('worker', env.logLevel);
installCrashHandlers(log);
for (const w of configWarnings) log.warn(w, { appEnv: env.appEnv });
logConfigurationLoaded(log, env);
try {
  const workerId = hostname();
  const connectors = buildConnectorRegistry();
  const jobs = buildJobRegistry();
  // One Postgres client per concurrent job on a registered platform, capped.
  const jobConsumerConnections = Math.min(
    32,
    connectors.platforms().reduce((sum, p) => sum + env.jobs.concurrency[p], 0),
  );
  const pool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-worker',
    max: env.concurrency + 2 + jobConsumerConnections,
    onIdleError: (err) => log.warn('postgres idle client error', errorFields(err)),
  });
  const redis = createWorkerConnection(env.redisUrl.href);
  const producerRedis = createProducerConnection(env.redisUrl.href);
  for (const [name, client] of [
    ['redis', redis],
    ['redis producer', producerRedis],
  ] as const) {
    client.on('error', (err) => log.warn(`${name} connection error`, errorFields(err)));
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
  const metrics = new JobMetrics(log);
  const ledger = new PgJobLedger(pool);
  const queues = new QueueSet({ connection: producerRedis, prefix: env.jobs.prefix });
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

  onShutdown(async () => {
    await Promise.all([worker.close(), jobWorkers.close()]);
    await queues.close();
    await health.close();
    await Promise.allSettled([pool.end(), redis.quit(), producerRedis.quit()]);
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
