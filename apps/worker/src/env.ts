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
import { parseInstagramEnv, type InstagramConfig } from '@feedbouncer/connector-instagram';
import { parseMetaAdsEnv, type MetaAdsConfig } from '@feedbouncer/connector-meta-ads';
import type { PollSettings, SchedulerSettings } from '@feedbouncer/comments';
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
  /** Null unless INSTAGRAM_CONNECTOR_ENABLED=true; runs on the Facebook Meta app, so it requires it. */
  readonly instagram: InstagramConfig | null;
  /** Null unless META_ADS_CONNECTOR_ENABLED=true; runs on the Facebook Meta app, so it requires it. */
  readonly metaAds: MetaAdsConfig | null;
  /** Cadence of ad discovery and ad comment polling; used only when `metaAds` is set. */
  readonly adPolling: AdPollingConfig;
  /** Null unless Facebook is configured: only the Facebook connector sends mail or needs the web origin. */
  readonly mail: WorkerMailConfig | null;
}

export interface AdPollingConfig {
  readonly poll: PollSettings;
  readonly scheduler: SchedulerSettings;
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

function readAdPollingConfig(env: Env): AdPollingConfig {
  const commentPollSec = readInt(env, 'COMMENT_POLL_INTERVAL_SEC', {
    min: 60,
    max: 3600,
    fallback: 300,
  });
  const pollIntervalSec = readInt(env, 'AD_POLL_INTERVAL_SEC', {
    min: 60,
    max: 3600,
    fallback: commentPollSec,
  });
  const graceDays = readInt(env, 'AD_RETIREMENT_GRACE_DAYS', { min: 0, max: 30, fallback: 7 });
  return {
    poll: {
      intervalSec: pollIntervalSec,
      graceDays,
      maxSourcesPerJob: readInt(env, 'AD_POLL_MAX_SOURCES_PER_JOB', {
        min: 1,
        max: 1000,
        fallback: 100,
      }),
      unavailableRetrySec: readInt(env, 'AD_SOURCE_UNAVAILABLE_RETRY_SEC', {
        min: 600,
        max: 604_800,
        fallback: 21_600,
      }),
      igDeepScanSec: readInt(env, 'AD_IG_DEEP_SCAN_INTERVAL_SEC', {
        min: 3600,
        max: 604_800,
        fallback: 86_400,
      }),
      overlapMs: 60_000,
      softDeadlineMs: 90_000,
      pageSize: 100,
    },
    scheduler: {
      tickSec: readInt(env, 'AD_SCHEDULER_TICK_SEC', { min: 10, max: 300, fallback: 30 }),
      discoveryIntervalSec: readInt(env, 'AD_DISCOVERY_INTERVAL_SEC', {
        min: 300,
        max: 86_400,
        fallback: 900,
      }),
      pollIntervalSec,
      graceDays,
      maxConnectionsPerTick: readInt(env, 'AD_SCHEDULER_MAX_CONNECTIONS_PER_TICK', {
        min: 1,
        max: 10_000,
        fallback: 500,
      }),
    },
  };
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
  const instagram = parseInstagramEnv(env, facebook);
  const metaAds = parseMetaAdsEnv(env, facebook);
  const adPolling = readAdPollingConfig(env);
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
    instagram,
    metaAds,
    adPolling,
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
    instagramEnabled: config.instagram !== null,
    metaAdsEnabled: config.metaAds !== null,
    activeKeyId: config.encryption.activeKeyId,
    jobQueuePrefix: config.jobs.prefix,
    jobDlqRetentionDays: config.jobs.dlqRetentionMs / 86_400_000,
    metricsPort: config.telemetry.metrics.port,
    metricsHost: config.telemetry.metrics.host,
    tracesExporter: config.telemetry.traces.exporter,
  });
}
