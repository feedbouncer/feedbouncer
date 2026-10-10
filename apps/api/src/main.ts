// API skeleton: health endpoints only. The NestJS ticket replaces the HTTP
// layer; keep the checks (postgres SELECT 1, redis PING) and their contract.
import { Redis } from 'ioredis';
import { createPool } from '@feedbouncer/db';
import {
  EnvError,
  createLogger,
  errorFields,
  onShutdown,
  startHealthServer,
} from '@feedbouncer/service-runtime';
import { loadApiEnv, type ApiEnv } from './env.js';

let env: ApiEnv;
try {
  env = loadApiEnv(process.env);
} catch (err) {
  process.stderr.write(`${err instanceof EnvError ? err.message : 'Invalid configuration'}\n`);
  process.exit(1);
}

const log = createLogger('api', env.logLevel);
const pool = createPool(env.databaseUrl, {
  applicationName: 'feedbouncer-api',
  onIdleError: (err) => log.warn('postgres idle client error', errorFields(err)),
});
// Fail fast while Redis is unreachable, so /healthz reports "down" instead of hanging.
const redis = new Redis(env.redisUrl.href, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', (err) => log.warn('redis connection error', errorFields(err)));

const server = await startHealthServer({
  host: '0.0.0.0',
  port: env.port,
  timeoutMs: 1_000,
  checks: {
    postgres: () => pool.query('SELECT 1'),
    redis: () => redis.ping(),
  },
  onFailure: (name, err) => log.warn('health check failed', { check: name, ...errorFields(err) }),
});
log.info('api listening', { port: server.port });

onShutdown(async () => {
  await server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
}, log);
