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
import { normalizeAddress } from '@feedbouncer/mailer';
import { parseAlertChannels, readAlertLimits } from '@feedbouncer/alerts';
import {
  FACEBOOK_FILE_VARS,
  parseFacebookEnv,
  type FacebookConfig,
} from '@feedbouncer/connector-facebook';
import { parseMetaAdsEnv, type MetaAdsConfig } from '@feedbouncer/connector-meta-ads';
import { parseInstagramEnv, type InstagramConfig } from '@feedbouncer/connector-instagram';
import { describeClassifierProvider } from '@feedbouncer/classifier';
import { loadPolicyLimits } from '@feedbouncer/policies';
import { readAllowedPrivateCidrs } from '@feedbouncer/webhooks';
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
  /** Null when SIGNUP_ALLOWED_EMAILS is unset: anyone may sign up. Otherwise the normalized addresses allowed to (invited emails always may). */
  readonly signupAllowlist: ReadonlySet<string> | null;
  /** Contact address shown in the "private beta" email; null when BETA_SUPPORT_EMAIL is unset. */
  readonly betaSupportEmail: string | null;
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
  /** Null unless META_ADS_CONNECTOR_ENABLED=true; also requires the Facebook config. */
  readonly metaAds: MetaAdsConfig | null;
  /** Queue prefix and dedup window, shared with the worker so both sides use the same queues. */
  readonly jobs: JobsConfig;
  /** The classifier's provider and model, for display only: the API holds no key. */
  readonly classifier: { readonly id: string; readonly model: string; readonly enabled: boolean };
  /** Policy checks: the monthly call budget and whether the deployment has an evaluation model. */
  readonly policy: ReturnType<typeof loadPolicyLimits>;
  /** Requests per minute allowed to each API key of the public /v1 API. */
  readonly publicApiRateLimitPerMinute: number;
  /** Hours a rule-change proposal made through the public API waits for review before it expires. */
  readonly ruleProposalTtlHours: number;
  /** Private networks, besides public addresses, that webhook endpoints may point at. Empty by default. */
  readonly webhookAllowedPrivateCidrs: readonly string[];
  readonly telemetry: TelemetryConfig;
  readonly health: HealthPolicy;
  /** Which alert channels this deployment offers and the per-workspace hourly alert cap. */
  readonly alerts: {
    readonly slack: boolean;
    readonly email: boolean;
    readonly capPerHour: number;
    readonly emailPerMinute: number;
  };
}

export interface LoadEnvOptions {
  /** Receives value-free warnings (e.g. dev placeholder in use). Log them once the logger exists. */
  readonly warn: (msg: string) => void;
  readonly fs?: SecretFileSystem;
}

const SIGNUP_ALLOWLIST_MAX = 200;

function parseEmailList(raw: string | undefined, name: string): ReadonlySet<string> | null {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  if (items.length > SIGNUP_ALLOWLIST_MAX) {
    throw new EnvError(`${name} has too many entries (at most ${SIGNUP_ALLOWLIST_MAX}).`);
  }
  return new Set(items.map((item) => parseEmail(item, name)));
}

function parseEmail(raw: string, name: string): string {
  const email = normalizeAddress(raw);
  if (email === null || !email.includes('@')) {
    throw new EnvError(`${name} contains an invalid email`);
  }
  return email;
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
    signupAllowlist: parseEmailList(env.SIGNUP_ALLOWED_EMAILS, 'SIGNUP_ALLOWED_EMAILS'),
    betaSupportEmail: env.BETA_SUPPORT_EMAIL?.trim()
      ? parseEmail(env.BETA_SUPPORT_EMAIL, 'BETA_SUPPORT_EMAIL')
      : null,
    trustProxyHops: readInt(env, 'TRUST_PROXY_HOPS', { min: 0, max: 5, fallback: 0 }),
    encryption: loadEncryptionKeyring(env, appEnv, opts.warn),
    facebook,
    instagram: parseInstagramEnv(env, facebook),
    metaAds: parseMetaAdsEnv(env, facebook),
    jobs: loadJobsConfig(env),
    classifier: describeClassifierProvider(env),
    policy: loadPolicyLimits(env),
    publicApiRateLimitPerMinute: readInt(env, 'PUBLIC_API_RATE_LIMIT_PER_MINUTE', {
      min: 1,
      max: 10_000,
      fallback: 60,
    }),
    ruleProposalTtlHours: readInt(env, 'RULE_PROPOSAL_TTL_HOURS', {
      min: 1,
      max: 168,
      fallback: 24,
    }),
    webhookAllowedPrivateCidrs: readAllowedPrivateCidrs(env),
    telemetry: loadTelemetryConfig(env, 'api'),
    health: loadHealthPolicy(env),
    alerts: {
      ...parseAlertChannels(env.ALERT_CHANNELS),
      ...readAlertLimits(env),
    },
  };
  // A whole-config dump (JSON, util.inspect) must never carry secrets or URL passwords.
  return redactOnSerialize(config, {
    appEnv,
    port: config.port,
    publicApiRateLimitPerMinute: config.publicApiRateLimitPerMinute,
    ruleProposalTtlHours: config.ruleProposalTtlHours,
    logLevel: config.logLevel,
    publicWebUrl: publicWebUrl.origin,
    trustProxyHops: config.trustProxyHops,
    facebookEnabled: config.facebook !== null,
    instagramEnabled: config.instagram !== null,
    metaAdsEnabled: config.metaAds !== null,
    alertSlackEnabled: config.alerts.slack,
    alertEmailEnabled: config.alerts.email,
    classifierEnabled: config.classifier.enabled,
    policyEvaluationEnabled: config.policy.evaluatorConfigured,
    jobQueuePrefix: config.jobs.prefix,
    activeKeyId: config.encryption.activeKeyId,
    metricsPort: config.telemetry.metrics.port,
    metricsHost: config.telemetry.metrics.host,
    tracesExporter: config.telemetry.traces.exporter,
  });
}
