import type { QuotaMeter } from '@feedbouncer/connectors';
import {
  EnvError,
  Secret,
  readInt,
  readSecret,
  readString,
  type Env,
} from '@feedbouncer/service-runtime';

/** The connector's own name for the scope; Google's URL form appears only in the consent URL. */
export const YOUTUBE_SCOPE_SHORT = 'youtube.force-ssl';
export const YOUTUBE_SCOPE_URL = 'https://www.googleapis.com/auth/youtube.force-ssl';
export const API_HOSTS: readonly string[] = ['www.googleapis.com', 'oauth2.googleapis.com'];
export const AUTH_HOSTS: readonly string[] = ['accounts.google.com'];

export interface YouTubeConnectorConfig {
  readonly clientId: string;
  readonly clientSecret: Secret;
  /** Meters OAuth-time calls (purpose `connect`), which have no connection yet. */
  readonly projectQuota?: QuotaMeter;
}

/** What the deployment configures: the OAuth client, the project quota and the cycle tuning. */
export interface YouTubeEnvConfig {
  readonly clientId: string;
  readonly clientSecret: Secret;
  readonly projectDailyQuota: number;
  /** Units kept free for other tools on the same Google project. */
  readonly projectHeadroomUnits: number;
  readonly schedulerTickSec: number;
  /** Most queued moderation actions kept per connection. */
  readonly backlogCap: number;
}

/** Settings that may be supplied as <NAME>_FILE. Apps add these to their own *_FILE_VARS. */
export const YOUTUBE_FILE_VARS = ['YOUTUBE_CLIENT_SECRET'] as const;

/** Null unless YOUTUBE_CONNECTOR_ENABLED=true. EnvError names the variable, never its value. */
export function parseYouTubeEnv(env: Env): YouTubeEnvConfig | null {
  const flag = env.YOUTUBE_CONNECTOR_ENABLED;
  if (flag === undefined || flag === '' || flag === 'false') return null;
  if (flag !== 'true') throw new EnvError('YOUTUBE_CONNECTOR_ENABLED must be "true" or "false"');
  const clientId = readString(env, 'YOUTUBE_CLIENT_ID', {
    fallback: '',
    maxLength: 256,
    pattern: /^\S+$/,
  });
  const clientSecret = readSecret(env, 'YOUTUBE_CLIENT_SECRET', { minLength: 8 });
  if (clientSecret.length > 256) {
    throw new EnvError('YOUTUBE_CLIENT_SECRET must be at most 256 characters (value not shown).');
  }
  const projectDailyQuota = readInt(env, 'YOUTUBE_PROJECT_DAILY_QUOTA', {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 10_000,
  });
  const projectHeadroomUnits = readInt(env, 'YOUTUBE_PROJECT_HEADROOM_UNITS', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 1000,
  });
  if (projectHeadroomUnits >= projectDailyQuota) {
    throw new EnvError(
      'YOUTUBE_PROJECT_HEADROOM_UNITS must be less than YOUTUBE_PROJECT_DAILY_QUOTA',
    );
  }
  return {
    clientId,
    clientSecret: new Secret(clientSecret),
    projectDailyQuota,
    projectHeadroomUnits,
    schedulerTickSec: readInt(env, 'YOUTUBE_SCHEDULER_TICK_SEC', {
      min: 10,
      max: 600,
      fallback: 60,
    }),
    backlogCap: readInt(env, 'YOUTUBE_BACKLOG_CAP', { min: 100, max: 100_000, fallback: 5000 }),
  };
}
