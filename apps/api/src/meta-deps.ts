// The Meta connectors (Facebook, and Instagram through Facebook Login). Null when
// Facebook is not configured. Instagram and Meta Ads run on the same Meta app, so
// they are only ever registered alongside Facebook and share its app secret.
import { createFacebookConnector } from '@feedbouncer/connector-facebook';
import { createInstagramConnector } from '@feedbouncer/connector-instagram';
import { createMetaAdsConnector } from '@feedbouncer/connector-meta-ads';
import type { Connector } from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';
import type { ApiEnv } from './env.js';

export interface MetaDeps {
  readonly connectors: readonly Connector[];
  readonly appSecrets: Partial<Record<'facebook' | 'instagram' | 'meta_ads', Secret>>;
}

export function buildMetaDeps(
  env: Pick<ApiEnv, 'facebook' | 'instagram' | 'metaAds'>,
): MetaDeps | null {
  const fb = env.facebook;
  if (!fb) return null;
  return {
    connectors: [
      createFacebookConnector(fb),
      ...(env.instagram ? [createInstagramConnector(env.instagram)] : []),
      ...(env.metaAds ? [createMetaAdsConnector(env.metaAds)] : []),
    ],
    appSecrets: {
      facebook: fb.appSecret,
      ...(env.instagram && { instagram: fb.appSecret }),
      ...(env.metaAds && { meta_ads: fb.appSecret }),
    },
  };
}
