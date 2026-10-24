import { Secret } from '@feedbouncer/service-runtime';
import { describe, expect, it } from 'vitest';
import { validateConnector } from '@feedbouncer/connectors';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { createTikTokAdsConnector } from './connector.js';
import { APP } from './test-world.js';

const c = createTikTokAdsConnector({ ...APP, appSecret: new Secret(APP.appSecret) });

describe('createTikTokAdsConnector', () => {
  it('passes framework validation', () => expect(() => validateConnector(c)).not.toThrow());
  it('declares the ad capabilities', () => {
    expect(c.platform).toBe('tiktok_ads');
    expect(c.capabilities).toMatchObject({
      ingestion: 'polling',
      accountSelection: 'multiple',
      oauthCodeParam: 'auth_code',
      listSources: false,
      connectionComments: true,
      actions: ['hide', 'unhide', 'delete'],
      responses: ['public_reply'],
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: {
        points: 60,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: [TIKTOK_API_HOST],
      authorizationHosts: ['business-api.tiktok.com'],
      defaultScopes: [],
      maxPageSize: 100,
    });
    expect(c.capabilities.accountIdPattern?.test('7300000000000001')).toBe(true);
    expect(c.capabilities.accountIdPattern?.test('a/b')).toBe(false);
  });
});
