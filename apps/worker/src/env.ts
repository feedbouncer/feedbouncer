import {
  LOG_LEVELS,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  readEnum,
  readInt,
  readUrl,
  type Env,
  type LogLevel,
} from '@feedbouncer/service-runtime';

export interface WorkerEnv {
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly concurrency: number;
  readonly healthPort: number;
  readonly logLevel: LogLevel;
}

export function loadWorkerEnv(env: Env): WorkerEnv {
  return {
    databaseUrl: readUrl(env, 'DATABASE_URL', PG_PROTOCOLS),
    redisUrl: readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS),
    concurrency: readInt(env, 'WORKER_CONCURRENCY', { min: 1, max: 64, fallback: 4 }),
    healthPort: readInt(env, 'HEALTH_PORT', { min: 1, max: 65_535, fallback: 3002 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
  };
}
