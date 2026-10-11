import {
  LOG_LEVELS,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  checkNotPlaceholder,
  readAppEnv,
  readEnum,
  readInt,
  readUrl,
  redactOnSerialize,
  resolveFileEnv,
  type AppEnv,
  type Env,
  type LogLevel,
  type SecretFileSystem,
} from '@feedbouncer/service-runtime';
import { ENCRYPTION_FILE_VARS, loadEncryptionKeyring, type Keyring } from '@feedbouncer/secrets';

export const WORKER_FILE_VARS = ['DATABASE_URL', 'REDIS_URL', ...ENCRYPTION_FILE_VARS] as const;

export interface WorkerEnv {
  readonly appEnv: AppEnv;
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly concurrency: number;
  readonly healthPort: number;
  readonly logLevel: LogLevel;
  readonly encryption: Keyring;
}

/** The worker's single typed configuration layer. Call once, from main.ts. */
export function loadWorkerEnv(
  rawEnv: Env,
  opts: { readonly warn: (msg: string) => void; readonly fs?: SecretFileSystem },
): WorkerEnv {
  const env = resolveFileEnv(rawEnv, WORKER_FILE_VARS, opts.fs);
  const appEnv = readAppEnv(env);
  const databaseUrl = readUrl(env, 'DATABASE_URL', PG_PROTOCOLS);
  const redisUrl = readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS);
  checkNotPlaceholder(appEnv, 'DATABASE_URL', databaseUrl.href, opts.warn);
  checkNotPlaceholder(appEnv, 'REDIS_URL', redisUrl.href, opts.warn);
  const config: WorkerEnv = {
    appEnv,
    databaseUrl,
    redisUrl,
    concurrency: readInt(env, 'WORKER_CONCURRENCY', { min: 1, max: 64, fallback: 4 }),
    healthPort: readInt(env, 'HEALTH_PORT', { min: 1, max: 65_535, fallback: 3002 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    encryption: loadEncryptionKeyring(env, appEnv, opts.warn),
  };
  // A whole-config dump (JSON, util.inspect) must never carry URL passwords or keys.
  return redactOnSerialize(config, {
    appEnv,
    concurrency: config.concurrency,
    healthPort: config.healthPort,
    logLevel: config.logLevel,
    activeEncryptionKeyId: config.encryption.activeKeyId,
  });
}
