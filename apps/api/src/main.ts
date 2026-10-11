// API process entry point: load config, create the shared resources, start
// NestJS on Fastify. The HTTP surface lives in app.factory.ts.
import { Redis } from 'ioredis';
import { createPool } from '@feedbouncer/db';
import { createSmtpMailer } from '@feedbouncer/mailer';
import { reportKeyCoverage } from '@feedbouncer/secrets';
import {
  EnvError,
  createLogger,
  errorFields,
  installCrashHandlers,
  onShutdown,
} from '@feedbouncer/service-runtime';
import { buildApp } from './app.factory.js';
import { loadApiEnv, type ApiEnv } from './env.js';

let env: ApiEnv;
const configWarnings: string[] = [];
try {
  env = loadApiEnv(process.env, { warn: (m) => configWarnings.push(m) });
} catch (err) {
  process.stderr.write(`${err instanceof EnvError ? err.message : 'Invalid configuration'}\n`);
  process.exit(1);
}

const log = createLogger('api', env.logLevel);
installCrashHandlers(log);
for (const w of configWarnings) log.warn(w, { appEnv: env.appEnv });
log.info('configuration loaded', {
  appEnv: env.appEnv,
  activeEncryptionKeyId: env.encryption.activeKeyId,
});
const pool = createPool(env.databaseUrl, {
  applicationName: 'feedbouncer-api',
  onIdleError: (err) => log.warn('postgres idle client error', errorFields(err)),
});
// Fail fast while Redis is unreachable, so /healthz reports "down" instead of hanging.
const redis = new Redis(env.redisUrl.href, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (err) => log.warn('redis connection error', errorFields(err)));
const mailer = createSmtpMailer(env.smtpUrl, env.mailFrom);

async function closeResources(): Promise<void> {
  mailer.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
}

try {
  const app = await buildApp({ env, pool, redis, mailer, log, redisKeyPrefix: 'fb:' });
  await app.listen({ host: '0.0.0.0', port: env.port });
  log.info('api listening', { port: env.port });
  void reportKeyCoverage(pool, env.encryption, log);
  onShutdown(async () => {
    await app.close();
    await closeResources();
  }, log);
} catch (err) {
  log.error('api failed to start', errorFields(err));
  await closeResources();
  process.exit(1);
}
