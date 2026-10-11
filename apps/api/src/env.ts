import {
  EnvError,
  LOG_LEVELS,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  readEnum,
  readInt,
  readSecret,
  readString,
  readUrl,
  type Env,
  type LogLevel,
} from '@feedbouncer/service-runtime';

export const SMTP_PROTOCOLS = ['smtp:', 'smtps:'] as const;
export const HTTP_PROTOCOLS = ['http:', 'https:'] as const;

export interface ApiEnv {
  readonly databaseUrl: URL;
  readonly redisUrl: URL;
  readonly port: number;
  readonly logLevel: LogLevel;
  /** Signs session cookies. Never log it. */
  readonly authSecret: string;
  /** Origin of the web app: the only allowed Origin for state-changing requests. */
  readonly publicWebUrl: URL;
  readonly smtpUrl: URL;
  readonly mailFrom: string;
  /** Reverse-proxy hops to trust for the client IP (Fastify trustProxy). */
  readonly trustProxyHops: number;
}

export function loadApiEnv(env: Env): ApiEnv {
  const publicWebUrl = readUrl(env, 'PUBLIC_WEB_URL', HTTP_PROTOCOLS);
  if (publicWebUrl.pathname !== '/' || publicWebUrl.search || publicWebUrl.hash) {
    throw new EnvError('PUBLIC_WEB_URL must be an origin only, e.g. https://app.example.com');
  }
  return {
    databaseUrl: readUrl(env, 'DATABASE_URL', PG_PROTOCOLS),
    redisUrl: readUrl(env, 'REDIS_URL', REDIS_PROTOCOLS),
    port: readInt(env, 'PORT', { min: 1, max: 65_535, fallback: 3001 }),
    logLevel: readEnum(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    authSecret: readSecret(env, 'AUTH_SECRET', { minLength: 32 }),
    publicWebUrl,
    smtpUrl: readUrl(env, 'SMTP_URL', SMTP_PROTOCOLS),
    mailFrom: readString(env, 'MAIL_FROM', {
      fallback: 'FeedBouncer <no-reply@localhost>',
      maxLength: 200,
      pattern: /^[^\r\n]+$/,
    }),
    trustProxyHops: readInt(env, 'TRUST_PROXY_HOPS', { min: 0, max: 5, fallback: 0 }),
  };
}
