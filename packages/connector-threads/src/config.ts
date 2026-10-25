import {
  EnvError,
  Secret,
  readInt,
  readRequiredString,
  readSecret,
  type Env,
} from '@feedbouncer/service-runtime';

export const THREADS_SCOPES = [
  'threads_basic',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_content_publish',
] as const;
export const THREADS_REQUIRED_SCOPES = ['threads_basic', 'threads_read_replies'] as const;
export type ThreadsScope = (typeof THREADS_SCOPES)[number];

export const THREADS_ACTION_SCOPES = {
  hide: ['threads_manage_replies'],
  unhide: ['threads_manage_replies'],
  public_reply: ['threads_manage_replies', 'threads_content_publish'],
} as const;

/** Shown before connecting. The text is the product's own, never the platform's. */
export const THREADS_SCOPE_PURPOSES: Readonly<Record<ThreadsScope, string>> = {
  threads_basic: 'See your profile and list your posts, so FeedBouncer knows which posts to watch.',
  threads_read_replies: 'Read replies to your posts, so your rules can check them. Required.',
  threads_manage_replies:
    'Hide and unhide replies, and post replies, when your rules say so. Without it, rules can only flag replies for review.',
  threads_content_publish:
    "Publish the replies your rules send. Without it, rules can't post replies.",
};

/** Maximum characters in a Threads text post (V8). */
export const THREADS_MAX_REPLY_CHARS = 500;

export const THREADS_RATE_LIMIT = {
  points: 30,
  durationSec: 60,
  urgentReservePoints: 8,
  backgroundPoints: 10,
  defaultRetryAfterMs: 60_000,
} as const;

/** Width of the slot that makes a poll job idempotent: wake-ups within it share one job. */
export const THREADS_WAKE_TICK_SEC = 5;
export const THREADS_ACTIVE_POST_DAYS = 14;
export const THREADS_QUIET_POST_POLL_INTERVAL_SEC = 21_600;
export const THREADS_FULL_SCAN_INTERVAL_SEC = 86_400;
export const THREADS_POLL_OVERLAP_SEC = 900;
export const THREADS_MAX_PAGES_PER_SOURCE_PASS = 10;
export const THREADS_SOURCES_PER_PASS = 25;
export const THREADS_PENDING_LOOKUPS_PER_PASS = 50;
export const THREADS_PENDING_MAX_ATTEMPTS = 5;
export const THREADS_REPLY_QUOTA_RETRY_SEC = 900;
export const THREADS_TOKEN_REFRESH_LEAD_SEC = 604_800;

export const THREADS_API_HOST = 'graph.threads.net';
export const THREADS_AUTHORIZATION_HOSTS: readonly string[] = ['threads.com', 'threads.net'];

export interface ThreadsConfig {
  readonly appId: string;
  readonly appSecret: Secret;
  /** Null: the webhook route is not registered and polling carries ingestion. */
  readonly webhookVerifyToken: Secret | null;
  readonly pollIntervalSec: number;
  readonly discoveryIntervalSec: number;
}

/** Settings that may be supplied as <NAME>_FILE. Apps add these to their own *_FILE_VARS. */
export const THREADS_FILE_VARS = ['THREADS_APP_SECRET', 'THREADS_WEBHOOK_VERIFY_TOKEN'] as const;

/** Null unless THREADS_CONNECTOR_ENABLED=true. EnvError names the variable, never its value. */
export function parseThreadsEnv(env: Env): ThreadsConfig | null {
  const flag = env.THREADS_CONNECTOR_ENABLED;
  if (flag === undefined || flag === '' || flag === 'false') return null;
  if (flag !== 'true') throw new EnvError('THREADS_CONNECTOR_ENABLED must be "true" or "false"');
  const appId = readRequiredString(env, 'THREADS_APP_ID', { maxLength: 32, pattern: /^\d{1,32}$/ });
  const appSecret = readSecret(env, 'THREADS_APP_SECRET', { minLength: 8 });
  if (appSecret.length > 256) {
    throw new EnvError('THREADS_APP_SECRET must be at most 256 characters (value not shown).');
  }
  const verify = env.THREADS_WEBHOOK_VERIFY_TOKEN;
  let webhookVerifyToken: Secret | null = null;
  if (verify !== undefined && verify !== '') {
    const token = readSecret(env, 'THREADS_WEBHOOK_VERIFY_TOKEN', { minLength: 8 });
    if (token.length > 256) {
      throw new EnvError(
        'THREADS_WEBHOOK_VERIFY_TOKEN must be at most 256 characters (value not shown).',
      );
    }
    webhookVerifyToken = new Secret(token);
  }
  return {
    appId,
    appSecret: new Secret(appSecret),
    webhookVerifyToken,
    pollIntervalSec: readInt(env, 'THREADS_POLL_INTERVAL_SEC', {
      min: 60,
      max: 3600,
      fallback: 600,
    }),
    discoveryIntervalSec: readInt(env, 'THREADS_DISCOVERY_INTERVAL_SEC', {
      min: 300,
      max: 21_600,
      fallback: 900,
    }),
  };
}
