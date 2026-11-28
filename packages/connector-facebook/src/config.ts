import {
  EnvError,
  Secret,
  checkNotPlaceholder,
  readAppEnv,
  readSecret,
  readString,
  type Env,
} from '@feedbouncer/service-runtime';

export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'pages_messaging',
] as const;
/** Settings that may be supplied as <NAME>_FILE. Apps add these to their own *_FILE_VARS. */
export const FACEBOOK_FILE_VARS = ['FACEBOOK_APP_SECRET', 'FACEBOOK_WEBHOOK_VERIFY_TOKEN'] as const;

export interface FacebookConfig {
  readonly appId: string;
  readonly appSecret: Secret;
  readonly graphVersion: string;
  /**
   * Echoed by Meta in the hub.verify_token handshake. Only the API's webhook
   * route reads this; null for a caller that opts out via
   * `requireWebhookToken: false` (the worker, which never handles webhooks
   * and so is not granted this secret -- see infra/docs/secrets.md).
   */
  readonly webhookVerifyToken: Secret | null;
}

/** Null when FACEBOOK_APP_ID is unset (connector not enabled); throws EnvError on partial or invalid config. */
export function parseFacebookEnv(
  env: Env,
  warn: (msg: string) => void,
  opts: { readonly requireWebhookToken?: boolean } = {},
): FacebookConfig | null {
  const appId = env.FACEBOOK_APP_ID?.trim();
  if (!appId) return null;
  if (!/^\d{5,20}$/.test(appId)) {
    throw new EnvError('FACEBOOK_APP_ID must be the numeric Meta app id.');
  }
  const appEnv = readAppEnv(env);
  const appSecret = readSecret(env, 'FACEBOOK_APP_SECRET', { minLength: 16 });
  checkNotPlaceholder(appEnv, 'FACEBOOK_APP_SECRET', appSecret, warn);
  const requireWebhookToken = opts.requireWebhookToken ?? true;
  let webhookVerifyToken: Secret | null = null;
  if (requireWebhookToken || env.FACEBOOK_WEBHOOK_VERIFY_TOKEN?.trim()) {
    const token = readSecret(env, 'FACEBOOK_WEBHOOK_VERIFY_TOKEN', { minLength: 20 });
    checkNotPlaceholder(appEnv, 'FACEBOOK_WEBHOOK_VERIFY_TOKEN', token, warn);
    webhookVerifyToken = new Secret(token);
  }
  return {
    appId,
    appSecret: new Secret(appSecret),
    webhookVerifyToken,
    graphVersion: readString(env, 'FACEBOOK_GRAPH_API_VERSION', {
      fallback: 'v26.0',
      maxLength: 8,
      pattern: /^v\d{2,3}\.0$/,
    }),
  };
}
