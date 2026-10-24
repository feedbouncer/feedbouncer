import { describe, expect, it } from 'vitest';
import { validateConnector } from '@feedbouncer/connectors';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { TIKTOK_ACTIONS, TIKTOK_SCOPES } from './config.js';
import { createTikTokConnector } from './connector.js';

const c = createTikTokConnector({ appId: '7300000000000001', appSecret: 'x'.repeat(24) });

describe('createTikTokConnector', () => {
  it('passes framework validation', () => expect(() => validateConnector(c)).not.toThrow());
  it('declares the OAuth and account capabilities', () => {
    expect(c.platform).toBe('tiktok');
    expect(c.capabilities).toMatchObject({
      ingestion: 'polling',
      accountSelection: 'multiple',
      oauthCodeParam: 'auth_code',
      tokens: { refreshable: true, rotatesRefreshToken: true },
      rateLimit: {
        points: 60,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: [TIKTOK_API_HOST],
      authorizationHosts: ['www.tiktok.com'],
      defaultScopes: [...TIKTOK_SCOPES],
      requiredScopes: [...TIKTOK_SCOPES],
      maxPageSize: 30,
    });
    expect(c.capabilities.accountIdPattern?.test('7300000000000001')).toBe(true);
    expect(c.capabilities.accountIdPattern?.test('a/b')).toBe(false);
    expect(TIKTOK_ACTIONS).toEqual(['hide', 'unhide', 'delete']);
  });
});
