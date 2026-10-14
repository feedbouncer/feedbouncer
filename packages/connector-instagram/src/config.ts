import { EnvError, type Env } from '@feedbouncer/service-runtime';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';

/** Without any of these a connected account cannot be moderated. */
export const INSTAGRAM_REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
] as const;
/** Requested scopes: the required ones plus private replies (see V2 in the README). */
export const INSTAGRAM_SCOPES = [
  ...INSTAGRAM_REQUIRED_SCOPES,
  'instagram_manage_messages',
] as const;

export interface InstagramConfig {
  /** Instagram via Facebook Login runs on the same Meta app as the Facebook connector. */
  readonly meta: FacebookConfig;
}

/** Null unless INSTAGRAM_CONNECTOR_ENABLED=true. Throws EnvError if enabled without a Facebook config, or if the flag is not 'true'|'false'. */
export function parseInstagramEnv(
  env: Env,
  facebook: FacebookConfig | null,
): InstagramConfig | null {
  const v = env.INSTAGRAM_CONNECTOR_ENABLED;
  if (v === undefined || v === '' || v === 'false') return null;
  if (v !== 'true') throw new EnvError('INSTAGRAM_CONNECTOR_ENABLED must be "true" or "false"');
  if (!facebook) {
    throw new EnvError(
      'INSTAGRAM_CONNECTOR_ENABLED=true requires the Facebook Meta app config (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_WEBHOOK_VERIFY_TOKEN)',
    );
  }
  return { meta: facebook };
}
