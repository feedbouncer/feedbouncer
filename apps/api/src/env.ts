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

export interface ApiEnv {
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export function loadApiEnv(env: Env): ApiEnv {
  return {
    databaseUrl: readUrl(env, 'DATABASE_URL', PG_PROTOCOLS),
    redisUrl: readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS),
    port: readInt(env, 'PORT', { min: 1, max: 65_535, fallback: 3001 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
  };
}
