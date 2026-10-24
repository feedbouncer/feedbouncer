import { Secret } from '@feedbouncer/service-runtime';
import { describe, expect, it } from 'vitest';
import type { ApiEnv } from './env.js';
import { buildTikTokDeps } from './tiktok-deps.js';

const organic = { appId: '7300000000000001', appSecret: new Secret('tiktok-secret-0123456789') };
const ads = { appId: '7300000000000002', appSecret: new Secret('tiktok-ads-secret-0123456789') };
const env = (o: Partial<Pick<ApiEnv, 'tiktok' | 'tiktokAds'>>) => ({
  tiktok: null,
  tiktokAds: null,
  ...o,
});

describe('buildTikTokDeps', () => {
  it('is null when neither connector is enabled', () => {
    expect(buildTikTokDeps(env({}))).toBeNull();
  });

  it('registers only the enabled connectors, each with its own app secret', () => {
    const one = buildTikTokDeps(env({ tiktok: organic }))!;
    expect(one.connectors.map((c) => c.platform)).toEqual(['tiktok']);
    expect(one.appSecrets).toEqual({ tiktok: organic.appSecret });

    const adsOnly = buildTikTokDeps(env({ tiktokAds: ads }))!;
    expect(adsOnly.connectors.map((c) => c.platform)).toEqual(['tiktok_ads']);
    expect(adsOnly.appSecrets).toEqual({ tiktok_ads: ads.appSecret });

    const both = buildTikTokDeps(env({ tiktok: organic, tiktokAds: ads }))!;
    expect(both.connectors.map((c) => c.platform)).toEqual(['tiktok', 'tiktok_ads']);
    expect(both.appSecrets).toEqual({ tiktok: organic.appSecret, tiktok_ads: ads.appSecret });
  });

  it('both connectors use the account picker', () => {
    const { connectors } = buildTikTokDeps(env({ tiktok: organic, tiktokAds: ads }))!;
    for (const c of connectors) expect(c.capabilities.accountSelection).toBe('multiple');
  });
});
