import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPool, runJobOnce } from '@feedbouncer/db';
import { reportKeyCoverage } from '@feedbouncer/secrets';
import {
  EnvError,
  createLogger,
  errorFields,
  installCrashHandlers,
  onShutdown,
  startHealthServer,
  waitUntil,
} from '@feedbouncer/service-runtime';
import { loadWorkerEnv, type WorkerEnv } from './env.js';
import { SYSTEM_QUEUE, createProcessor } from './processor.js';
import { logConfigurationLoaded, reportStartupFailure } from './startup.js';

let env: WorkerEnv;
const configWarnings: string[] = [];
try {
  env = loadWorkerEnv(process.env, { warn: (m) => configWarnings.push(m) });
} catch (err) {
  process.stderr.write(`${err instanceof EnvError ? err.message : 'Invalid configuration'}\n`);
  process.exit(1);
}

const log = createLogger('worker', env.logLevel);
installCrashHandlers(log);
for (const w of configWarnings) log.warn(w, { appEnv: env.appEnv });
logConfigurationLoaded(log, env);
try {
  const workerId = hostname();
  const pool = createPool(env.databaseUrl, {
    applicationName: 'feedbouncer-worker',
    max: env.concurrency + 2,
    onIdleError: (err) => log.warn('postgres idle client error', errorFields(err)),
  });
  const redis = new Redis(env.redisUrl.href, { maxRetriesPerRequest: null });
  redis.on('error', (err) => log.warn('redis connection error', errorFields(err)));

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
    },
    onFailure: (name, err) =>
      log.debug('health check failed', { check: name, ...errorFields(err) }),
  });

  onShutdown(async () => {
    await worker.close();
    await health.close();
    await Promise.allSettled([pool.end(), redis.quit()]);
  }, log);

  await waitUntil(() => Promise.all([pool.query('SELECT 1'), redis.ping()]), {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    attemptTimeoutMs: 2_000,
    onRetry: (attempt, err) =>
      log.warn('waiting for postgres/redis', { attempt, ...errorFields(err) }),
  });

  await reportKeyCoverage(pool, env.encryption, log);

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
