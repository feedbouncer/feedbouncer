import { EnvError, readSecret, Secret, readString, type Env } from '@feedbouncer/service-runtime';
import type { ModerationAction } from '@feedbouncer/connectors';

/** V4 */
export const TIKTOK_SCOPES = [
  'user.info.basic',
  'video.list',
  'comment.list',
  'comment.list.manage',
] as const;
/** V8: drop 'delete' if TikTok limits it to the account's own comments. */
export const TIKTOK_ACTIONS: readonly ModerationAction[] = ['hide', 'unhide', 'delete'];
/** V1 */
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

export interface TikTokConfig {
  readonly appId: string;
  readonly appSecret: Secret;
}

/** Settings that may be supplied as <NAME>_FILE. Apps add these to their own *_FILE_VARS. */
export const TIKTOK_FILE_VARS = ['TIKTOK_APP_SECRET'] as const;

const APP_ID = /^\d{1,32}$|^[A-Za-z0-9]{1,64}$/;

/** Null unless TIKTOK_CONNECTOR_ENABLED=true. EnvError names the variable, never its value. */
export function parseTikTokEnv(env: Env): TikTokConfig | null {
  const flag = env.TIKTOK_CONNECTOR_ENABLED;
  if (flag === undefined || flag === '' || flag === 'false') return null;
  if (flag !== 'true') throw new EnvError('TIKTOK_CONNECTOR_ENABLED must be "true" or "false"');
  const appId = readString(env, 'TIKTOK_APP_ID', { fallback: '', maxLength: 64, pattern: APP_ID });
  const appSecret = readSecret(env, 'TIKTOK_APP_SECRET', { minLength: 16 });
  if (appSecret.length > 128) {
    throw new EnvError('TIKTOK_APP_SECRET must be at most 128 characters (value not shown).');
  }
  return { appId, appSecret: new Secret(appSecret) };
}
