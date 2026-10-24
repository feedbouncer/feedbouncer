import { EnvError, readSecret, Secret, readString, type Env } from '@feedbouncer/service-runtime';
import type { ModerationAction, ResponseKind } from '@feedbouncer/connectors';

/** V15: drop 'delete' if the Marketing API does not allow it. */
export const TIKTOK_ADS_ACTIONS: readonly ModerationAction[] = ['hide', 'unhide', 'delete'];
/** V15: may become empty. */
export const TIKTOK_ADS_RESPONSES: readonly ResponseKind[] = ['public_reply'];
/** V11 */
export const TIKTOK_ADS_AUTHORIZE_URL = 'https://business-api.tiktok.com/portal/auth';
/** V14: the status-update field that carries HIDDEN / PUBLIC ('operation' or 'status'). */
export const AD_COMMENT_HIDE_FIELD = 'operation';

export interface TikTokAdsConfig {
  readonly appId: string;
  readonly appSecret: Secret;
}

/** Settings that may be supplied as <NAME>_FILE. Apps add these to their own *_FILE_VARS. */
export const TIKTOK_ADS_FILE_VARS = ['TIKTOK_ADS_APP_SECRET'] as const;

const APP_ID = /^\d{1,32}$|^[A-Za-z0-9]{1,64}$/;

/** Null unless TIKTOK_ADS_CONNECTOR_ENABLED=true. Credentials default to the organic app's. EnvError names the variable, never its value. */
export function parseTikTokAdsEnv(raw: Env): TikTokAdsConfig | null {
  const env: Env = {
    ...raw,
    TIKTOK_ADS_APP_ID: raw.TIKTOK_ADS_APP_ID || raw.TIKTOK_APP_ID,
    TIKTOK_ADS_APP_SECRET: raw.TIKTOK_ADS_APP_SECRET || raw.TIKTOK_APP_SECRET,
  };
  const flag = env.TIKTOK_ADS_CONNECTOR_ENABLED;
  if (flag === undefined || flag === '' || flag === 'false') return null;
  if (flag !== 'true') {
    throw new EnvError('TIKTOK_ADS_CONNECTOR_ENABLED must be "true" or "false"');
  }
  const appId = readString(env, 'TIKTOK_ADS_APP_ID', {
    fallback: '',
    maxLength: 64,
    pattern: APP_ID,
  });
  const appSecret = readSecret(env, 'TIKTOK_ADS_APP_SECRET', { minLength: 16 });
  if (appSecret.length > 128) {
    throw new EnvError('TIKTOK_ADS_APP_SECRET must be at most 128 characters (value not shown).');
  }
  return { appId, appSecret: new Secret(appSecret) };
}
