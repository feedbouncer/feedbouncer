// The TikTok connectors (organic accounts and ad accounts) the API registers for
// the connect flow and moderation actions. Independent of the Meta config: each
// runs on its own TikTok app. Null when neither is enabled.
import type { Connector } from '@feedbouncer/connectors';
import { createTikTokConnector } from '@feedbouncer/connector-tiktok';
import { createTikTokAdsConnector } from '@feedbouncer/connector-tiktok-ads';
import type { ApiEnv } from './env.js';

export interface TikTokDeps {
  readonly connectors: readonly Connector[];
  readonly appSecrets: Partial<Record<'tiktok' | 'tiktok_ads', string>>;
}

export function buildTikTokDeps(env: Pick<ApiEnv, 'tiktok' | 'tiktokAds'>): TikTokDeps | null {
  const { tiktok, tiktokAds } = env;
  if (!tiktok && !tiktokAds) return null;
  return {
    connectors: [
      ...(tiktok ? [createTikTokConnector(tiktok)] : []),
      ...(tiktokAds ? [createTikTokAdsConnector(tiktokAds)] : []),
    ],
    appSecrets: {
      ...(tiktok && { tiktok: tiktok.appSecret }),
      ...(tiktokAds && { tiktok_ads: tiktokAds.appSecret }),
    },
  };
}
