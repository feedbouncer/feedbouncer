import {
  EnvError,
  LOG_LEVELS,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  checkNotPlaceholder,
  readAppEnv,
  readEnum,
  readInt,
  Secret,
  readSecret,
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
import { parseInstagramEnv, type InstagramConfig } from '@feedbouncer/connector-instagram';
import { loadJobsConfig, type JobsConfig } from '@feedbouncer/jobs';
import {
  loadHealthPolicy,
  loadTelemetryConfig,
  type HealthPolicy,
  type TelemetryConfig,
} from '@feedbouncer/observability';
import { ENCRYPTION_FILE_VARS, loadEncryptionKeyring, type Keyring } from '@feedbouncer/secrets';

export const SMTP_PROTOCOLS = ['smtp:', 'smtps:'] as const;
export const HTTP_PROTOCOLS = ['http:', 'https:'] as const;
/** Settings that may be supplied as <NAME>_FILE (mounted secret files). */
export const API_FILE_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'AUTH_SECRET',
  'SMTP_URL',
  ...ENCRYPTION_FILE_VARS,
  ...FACEBOOK_FILE_VARS,
] as const;

export interface ApiEnv {
  readonly appEnv: AppEnv;
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Signs session cookies. Never log it. */
  readonly authSecret: Secret;
  /** Origin of the web app: the only allowed Origin for state-changing requests. */
  readonly publicWebUrl: URL;
  readonly smtpUrl: URL;
  readonly mailFrom: string;
  /** Reverse-proxy hops to trust for the client IP (Fastify trustProxy). */
  readonly trustProxyHops: number;
  /** Deployment keys for stored platform credentials. Serializes without key material. */
  readonly encryption: Keyring;
  /** Null when FACEBOOK_APP_ID is unset: the connector, its webhook route and its job producer are off. */
  readonly facebook: FacebookConfig | null;
  /**
   * Null unless INSTAGRAM_CONNECTOR_ENABLED=true. Runs on the Facebook Meta app,
   * so enabling it without the Facebook config fails startup.
   */
  readonly instagram: InstagramConfig | null;
  /** Queue prefix and dedup window, shared with the worker so both sides use the same queues. */
  readonly jobs: JobsConfig;
  readonly telemetry: TelemetryConfig;
  readonly health: HealthPolicy;
}

export interface LoadEnvOptions {
  /** Receives value-free warnings (e.g. dev placeholder in use). Log them once the logger exists. */
  readonly warn: (msg: string) => void;
  readonly fs?: SecretFileSystem;
}

/** The API's single typed configuration layer. Call once, from main.ts. */
export function loadApiEnv(rawEnv: Env, opts: LoadEnvOptions): ApiEnv {
  const env = resolveFileEnv(rawEnv, API_FILE_VARS, opts.fs);
  const appEnv = readAppEnv(env);
  const publicWebUrl = readUrl(env, 'PUBLIC_WEB_URL', HTTP_PROTOCOLS);
  if (publicWebUrl.pathname !== '/' || publicWebUrl.search || publicWebUrl.hash) {
    throw new EnvError('PUBLIC_WEB_URL must be an origin only, e.g. https://app.example.com');
  }
  const databaseUrl = readUrl(env, 'DATABASE_URL', PG_PROTOCOLS);
  const redisUrl = readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS);
  const smtpUrl = readUrl(env, 'SMTP_URL', SMTP_PROTOCOLS);
  const authSecret = readSecret(env, 'AUTH_SECRET', { minLength: 32 });
  checkNotPlaceholder(appEnv, 'DATABASE_URL', databaseUrl.href, opts.warn);
  checkNotPlaceholder(appEnv, 'REDIS_URL', redisUrl.href, opts.warn);
  checkNotPlaceholder(appEnv, 'AUTH_SECRET', authSecret, opts.warn);
  const facebook = parseFacebookEnv(env, opts.warn);
  const config: ApiEnv = {
    appEnv,
    databaseUrl,
    redisUrl,
    port: readInt(env, 'PORT', { min: 1, max: 65_535, fallback: 3001 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    authSecret: new Secret(authSecret),
    publicWebUrl,
    smtpUrl,
    mailFrom: readString(env, 'MAIL_FROM', {
      fallback: 'FeedBouncer <no-reply@localhost>',
      maxLength: 200,
      pattern: /^[^\r\n]+$/,
    }),
    trustProxyHops: readInt(env, 'TRUST_PROXY_HOPS', { min: 0, max: 5, fallback: 0 }),
    encryption: loadEncryptionKeyring(env, appEnv, opts.warn),
    facebook,
    instagram: parseInstagramEnv(env, facebook),
    jobs: loadJobsConfig(env),
    telemetry: loadTelemetryConfig(env, 'api'),
    health: loadHealthPolicy(env),
  };
  // A whole-config dump (JSON, util.inspect) must never carry secrets or URL passwords.
  return redactOnSerialize(config, {
    appEnv,
    port: config.port,
    logLevel: config.logLevel,
    publicWebUrl: publicWebUrl.origin,
    trustProxyHops: config.trustProxyHops,
    facebookEnabled: config.facebook !== null,
    instagramEnabled: config.instagram !== null,
    jobQueuePrefix: config.jobs.prefix,
    activeKeyId: config.encryption.activeKeyId,
    metricsPort: config.telemetry.metrics.port,
    metricsHost: config.telemetry.metrics.host,
    tracesExporter: config.telemetry.traces.exporter,
  });
}
