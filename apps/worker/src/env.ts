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
import { parseAlertChannels, readAlertLimits } from '@feedbouncer/alerts';
import { readAllowedPrivateCidrs } from '@feedbouncer/webhooks';
import {
  CLASSIFIER_FILE_VARS,
  CLASSIFIER_JOB_SPECS,
  CLASSIFIER_LANE,
  loadClassifierConfig,
  type ClassifierConfig,
} from '@feedbouncer/classifier';
import {
  POLICY_FILE_VARS,
  POLICY_JOB_SPECS,
  POLICY_LANE,
  loadPolicyConfig,
  type PolicyConfig,
} from '@feedbouncer/policies';
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
  ...CLASSIFIER_FILE_VARS,
  ...POLICY_FILE_VARS,
] as const;

/** Queue lanes the registered jobs run on; each gets JOB_CONCURRENCY_LANE_<LANE> consumers. */
const JOB_LANES = [
  ...new Set(
    [...CLASSIFIER_JOB_SPECS, ...POLICY_JOB_SPECS].flatMap((s) => ('lane' in s ? [s.lane] : [])),
  ),
].sort();
/** Wider than the per-brand cap (default 2), so one brand's backlog cannot hold every slot. */
const LANE_DEFAULTS = { [CLASSIFIER_LANE]: 4, [POLICY_LANE]: 4 } as const;

export interface WorkerEnv {
  readonly appEnv: AppEnv;
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly concurrency: number;
  /** Consumers of the moderation-check queue (text checked by API callers). */
  readonly moderationCheckConcurrency: number;
  readonly healthPort: number;
  readonly logLevel: LogLevel;
  readonly encryption: Keyring;
  readonly jobs: JobsConfig;
  readonly classifier: ClassifierConfig;
  readonly policy: PolicyConfig;
  readonly telemetry: TelemetryConfig;
  readonly health: HealthPolicy;
  /** Null when FACEBOOK_APP_ID is unset: the connector is not enabled. */
  readonly facebook: FacebookConfig | null;
  /** Null unless INSTAGRAM_CONNECTOR_ENABLED=true; runs on the Facebook Meta app, so it requires it. */
  readonly instagram: InstagramConfig | null;
  /** Null unless META_ADS_CONNECTOR_ENABLED=true; runs on the Facebook Meta app, so it requires it. */
  readonly metaAds: MetaAdsConfig | null;
  /** Cadence of ad discovery and ad comment polling; null exactly when `metaAds` is. */
  readonly adPolling: AdPollingConfig | null;
  /** Null unless Facebook, email alerts or weekly reports are enabled: only they send mail. */
  readonly mail: WorkerMailConfig | null;
  /** Web origin for links and OAuth redirects; null unless Facebook, an alert channel or weekly reports are on. */
  readonly publicWebUrl: URL | null;
  /** Which alert channels this deployment offers; both false means the alert loops do not run. */
  readonly alerts: WorkerAlertsConfig;
  /** WEEKLY_REPORTS=on: the weekly report loops run, which needs mail and PUBLIC_WEB_URL. */
  readonly weeklyReports: boolean;
  /** Outgoing webhook deliveries in flight at once across this worker. */
  readonly webhookConcurrency: number;
  /** Private networks webhook endpoints may point at; empty allows only public addresses. */
  readonly webhookAllowedPrivateCidrs: readonly string[];
}

export interface WorkerAlertsConfig {
  readonly slack: boolean;
  readonly email: boolean;
  readonly capPerHour: number;
  readonly emailPerMinute: number;
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

function readPublicWebUrl(env: Env): URL {
  const publicWebUrl = readUrl(env, 'PUBLIC_WEB_URL', HTTP_PROTOCOLS);
  if (publicWebUrl.pathname !== '/' || publicWebUrl.search || publicWebUrl.hash) {
    throw new EnvError('PUBLIC_WEB_URL must be an origin only, e.g. https://app.example.com');
  }
  return publicWebUrl;
}

function readMailConfig(env: Env, publicWebUrl: URL): WorkerMailConfig {
  const smtpUrl = readUrl(env, 'SMTP_URL', SMTP_PROTOCOLS);
  const mailFrom = readString(env, 'MAIL_FROM', {
    fallback: 'FeedBouncer <no-reply@localhost>',
    maxLength: 200,
    pattern: /^[^\r\n]+$/,
  });
  return { smtpUrl, mailFrom, publicWebUrl };
}

function readAdPollingConfig(env: Env): AdPollingConfig {
  const pollIntervalSec = readInt(env, 'AD_POLL_INTERVAL_SEC', {
    min: 60,
    max: 3600,
    fallback: 300,
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
  const adPolling = metaAds ? readAdPollingConfig(env) : null;
  const alerts = { ...parseAlertChannels(env.ALERT_CHANNELS), ...readAlertLimits(env) };
  const weeklyReports = readEnum(env, 'WEEKLY_REPORTS', ['on', 'off'], 'off') === 'on';
  const publicWebUrl =
    facebook || alerts.slack || alerts.email || weeklyReports ? readPublicWebUrl(env) : null;
  const mail =
    publicWebUrl && (facebook || alerts.email || weeklyReports)
      ? readMailConfig(env, publicWebUrl)
      : null;
  checkNotPlaceholder(appEnv, 'DATABASE_URL', databaseUrl.href, opts.warn);
  checkNotPlaceholder(appEnv, 'REDIS_URL', redisUrl.href, opts.warn);
  if (publicWebUrl) checkNotPlaceholder(appEnv, 'PUBLIC_WEB_URL', publicWebUrl.href, opts.warn);
  const jobs = loadJobsConfig(env, { lanes: JOB_LANES, laneDefaults: LANE_DEFAULTS });
  const classifier = loadClassifierConfig(env);
  const classifyLane = jobs.laneConcurrency[CLASSIFIER_LANE] ?? 0;
  if (classifyLane > 0 && classifyLane <= classifier.perBrandInFlight) {
    opts.warn(
      `JOB_CONCURRENCY_LANE_CLASSIFY (${classifyLane}) should exceed CLASSIFIER_BRAND_MAX_IN_FLIGHT (${classifier.perBrandInFlight}); otherwise one brand's backlog can hold every classification slot`,
    );
  }
  const policy = loadPolicyConfig(env);
  const policyLane = jobs.laneConcurrency[POLICY_LANE] ?? 0;
  if (policyLane > 0 && policyLane <= policy.perBrandInFlight) {
    opts.warn(
      `JOB_CONCURRENCY_LANE_POLICY (${policyLane}) should exceed POLICY_BRAND_MAX_IN_FLIGHT (${policy.perBrandInFlight}); otherwise one brand's backlog can hold every policy slot`,
    );
  }
  const config: WorkerEnv = {
    appEnv,
    databaseUrl,
    redisUrl,
    concurrency: readInt(env, 'WORKER_CONCURRENCY', { min: 1, max: 64, fallback: 4 }),
    moderationCheckConcurrency: readInt(env, 'MODERATION_CHECK_CONCURRENCY', {
      min: 1,
      max: 64,
      fallback: 4,
    }),
    healthPort: readInt(env, 'HEALTH_PORT', { min: 1, max: 65_535, fallback: 3002 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    encryption: loadEncryptionKeyring(env, appEnv, opts.warn),
    jobs,
    classifier,
    policy,
    telemetry: loadTelemetryConfig(env, 'worker'),
    health: loadHealthPolicy(env),
    facebook,
    instagram,
    metaAds,
    adPolling,
    mail,
    publicWebUrl,
    alerts,
    weeklyReports,
    webhookConcurrency: readInt(env, 'WEBHOOK_DISPATCH_CONCURRENCY', {
      min: 1,
      max: 256,
      fallback: 32,
    }),
    webhookAllowedPrivateCidrs: readAllowedPrivateCidrs(env),
  };
  // A whole-config dump (JSON, util.inspect) must never carry URL passwords or keys.
  return redactOnSerialize(config, {
    appEnv,
    concurrency: config.concurrency,
    healthPort: config.healthPort,
    logLevel: config.logLevel,
    publicWebUrl: publicWebUrl?.origin ?? null,
    facebookEnabled: config.facebook !== null,
    instagramEnabled: config.instagram !== null,
    metaAdsEnabled: config.metaAds !== null,
    alertSlackEnabled: alerts.slack,
    alertEmailEnabled: alerts.email,
    weeklyReportsEnabled: weeklyReports,
    activeKeyId: config.encryption.activeKeyId,
    jobQueuePrefix: config.jobs.prefix,
    classifierEnabled: config.classifier.model !== null,
    policyEnabled: config.policy.model !== null,
    jobDlqRetentionDays: config.jobs.dlqRetentionMs / 86_400_000,
    metricsPort: config.telemetry.metrics.port,
    metricsHost: config.telemetry.metrics.host,
    tracesExporter: config.telemetry.traces.exporter,
  });
}
