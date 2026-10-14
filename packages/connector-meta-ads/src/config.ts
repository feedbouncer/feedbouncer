import { EnvError, type Env } from '@feedbouncer/service-runtime';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';

/** Minimum privilege: reading ads never needs `ads_management`. */
export const META_ADS_SCOPES = ['ads_read'] as const;

const STATUS_LIST = /^[A-Z_]{1,40}(,[A-Z_]{1,40}){0,9}$/;

export interface MetaAdsConfig {
  /** Ads run on the same Meta app as the Facebook connector. */
  readonly meta: FacebookConfig;
  /** `effective_status` values that count as live ads. */
  readonly activeStatuses: readonly string[];
}

/** Null unless META_ADS_CONNECTOR_ENABLED=true. Throws EnvError if enabled without a Facebook config. */
export function parseMetaAdsEnv(env: Env, facebook: FacebookConfig | null): MetaAdsConfig | null {
  const v = env.META_ADS_CONNECTOR_ENABLED;
  if (v === undefined || v === '' || v === 'false') return null;
  if (v !== 'true') throw new EnvError('META_ADS_CONNECTOR_ENABLED must be "true" or "false"');
  if (!facebook) {
    throw new EnvError(
      'META_ADS_CONNECTOR_ENABLED=true requires the Facebook Meta app config (FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_WEBHOOK_VERIFY_TOKEN)',
    );
  }
  const s = env.META_ADS_ACTIVE_STATUSES;
  if (s !== undefined && s !== '' && !STATUS_LIST.test(s)) {
    throw new EnvError('META_ADS_ACTIVE_STATUSES must be a comma-separated list of 1-10 statuses');
  }
  return { meta: facebook, activeStatuses: s ? s.split(',') : ['ACTIVE'] };
}
