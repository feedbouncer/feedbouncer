import {
  EnvError,
  LOG_LEVELS,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  checkNotPlaceholder,
  readAppEnv,
  readEnum,
  readInt,
  readString,
  readUrl,
  redactOnSerialize,
  resolveFileEnv,
  type AppEnv,
  type Env,
  type LogLevel,
  type SecretFileSystem,
} from '@feedbouncer/service-runtime';
import {
  FACEBOOK_FILE_VARS,
  parseFacebookEnv,
  type FacebookConfig,
} from '@feedbouncer/connector-facebook';
import { loadJobsConfig, type JobsConfig } from '@feedbouncer/jobs';
import {
  loadHealthPolicy,
  loadTelemetryConfig,
  type HealthPolicy,
  type TelemetryConfig,
} from '@feedbouncer/observability';
import { ENCRYPTION_FILE_VARS, loadEncryptionKeyring, type Keyring } from '@feedbouncer/secrets';

const SMTP_PROTOCOLS = ['smtp:', 'smtps:'] as const;
const HTTP_PROTOCOLS = ['http:', 'https:'] as const;

/** Settings that may be supplied as <NAME>_FILE (mounted secret files). */
export const WORKER_FILE_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'SMTP_URL',
  ...ENCRYPTION_FILE_VARS,
  ...FACEBOOK_FILE_VARS,
] as const;

export interface WorkerEnv {
  readonly appEnv: AppEnv;
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly concurrency: number;
  readonly healthPort: number;
  readonly logLevel: LogLevel;
  readonly encryption: Keyring;
  readonly jobs: JobsConfig;
  readonly telemetry: TelemetryConfig;
  readonly health: HealthPolicy;
  /** Null when FACEBOOK_APP_ID is unset: the connector is not enabled. */
  readonly facebook: FacebookConfig | null;
  /** Null unless Facebook is configured: only the Facebook connector sends mail or needs the web origin. */
  readonly mail: WorkerMailConfig | null;
}

export interface WorkerMailConfig {
  readonly smtpUrl: URL;
  readonly mailFrom: string;
  /** Origin of the web app, used to build links in notification emails and the OAuth redirect URI. */
  readonly publicWebUrl: URL;
}

function readMailConfig(env: Env): WorkerMailConfig {
  const smtpUrl = readUrl(env, 'SMTP_URL', SMTP_PROTOCOLS);
  const publicWebUrl = readUrl(env, 'PUBLIC_WEB_URL', HTTP_PROTOCOLS);
  if (publicWebUrl.pathname !== '/' || publicWebUrl.search || publicWebUrl.hash) {
    throw new EnvError('PUBLIC_WEB_URL must be an origin only, e.g. https://app.example.com');
  }
  const mailFrom = readString(env, 'MAIL_FROM', {
    fallback: 'FeedBouncer <no-reply@localhost>',
    maxLength: 200,
    pattern: /^[^\r\n]+$/,
  });
  return { smtpUrl, mailFrom, publicWebUrl };
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
  const facebook = parseFacebookEnv(env, opts.warn);
  const mail = facebook ? readMailConfig(env) : null;
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
    jobs: loadJobsConfig(env),
    telemetry: loadTelemetryConfig(env, 'worker'),
    health: loadHealthPolicy(env),
    facebook,
    mail,
  };
  // A whole-config dump (JSON, util.inspect) must never carry URL passwords or keys.
  return redactOnSerialize(config, {
    appEnv,
    concurrency: config.concurrency,
    healthPort: config.healthPort,
    logLevel: config.logLevel,
    publicWebUrl: mail?.publicWebUrl.origin ?? null,
    facebookEnabled: config.facebook !== null,
    activeKeyId: config.encryption.activeKeyId,
    jobQueuePrefix: config.jobs.prefix,
    jobDlqRetentionDays: config.jobs.dlqRetentionMs / 86_400_000,
    metricsPort: config.telemetry.metrics.port,
    metricsHost: config.telemetry.metrics.host,
    tracesExporter: config.telemetry.traces.exporter,
  });
}
