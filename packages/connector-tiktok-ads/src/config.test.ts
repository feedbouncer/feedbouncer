import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import {
  AD_COMMENT_HIDE_FIELD,
  TIKTOK_ADS_ACTIONS,
  TIKTOK_ADS_AUTHORIZE_URL,
  TIKTOK_ADS_RESPONSES,
  parseTikTokAdsEnv,
} from './config.js';

const full = {
  TIKTOK_ADS_CONNECTOR_ENABLED: 'true',
  TIKTOK_ADS_APP_ID: '7300000000000002',
  TIKTOK_ADS_APP_SECRET: 's3cr3t-'.repeat(4),
};

describe('constants', () => {
  it('match the primary assumptions', () => {
    expect(TIKTOK_ADS_ACTIONS).toEqual(['hide', 'unhide', 'delete']);
    expect(TIKTOK_ADS_RESPONSES).toEqual(['public_reply']);
    expect(TIKTOK_ADS_AUTHORIZE_URL).toBe('https://business-api.tiktok.com/portal/auth');
    expect(AD_COMMENT_HIDE_FIELD).toBe('operation');
  });
});

describe('parseTikTokAdsEnv', () => {
  it('is disabled unless TIKTOK_ADS_CONNECTOR_ENABLED=true', () => {
    expect(parseTikTokAdsEnv({})).toBeNull();
    expect(parseTikTokAdsEnv({ ...full, TIKTOK_ADS_CONNECTOR_ENABLED: 'false' })).toBeNull();
  });
  it('reads the app id and secret', () => {
    expect(parseTikTokAdsEnv(full)).toEqual({
      appId: full.TIKTOK_ADS_APP_ID,
      appSecret: full.TIKTOK_ADS_APP_SECRET,
    });
  });
  it('falls back to the organic app credentials', () => {
    const shared = {
      TIKTOK_ADS_CONNECTOR_ENABLED: 'true',
      TIKTOK_APP_ID: '7300000000000001',
      TIKTOK_APP_SECRET: 'shared-s3cr3t-'.repeat(2),
    };
    expect(parseTikTokAdsEnv(shared)).toEqual({
      appId: shared.TIKTOK_APP_ID,
      appSecret: shared.TIKTOK_APP_SECRET,
    });
    expect(parseTikTokAdsEnv({ ...shared, ...full })).toEqual({
      appId: full.TIKTOK_ADS_APP_ID,
      appSecret: full.TIKTOK_ADS_APP_SECRET,
    });
  });
  it.each(['TIKTOK_ADS_APP_ID', 'TIKTOK_ADS_APP_SECRET'])(
    'names %s but never its value when it is missing or malformed',
    (name) => {
      expect(() => parseTikTokAdsEnv({ ...full, [name]: undefined })).toThrow(name);
      const bad = { ...full, [name]: name.endsWith('ID') ? 'bad id!' : 'short' };
      expect(() => parseTikTokAdsEnv(bad)).toThrow(name);
      expect(() => parseTikTokAdsEnv(bad)).not.toThrow(/bad id!|short/);
    },
  );
  it('rejects a secret longer than 128 characters and an unknown flag', () => {
    expect(() => parseTikTokAdsEnv({ ...full, TIKTOK_ADS_APP_SECRET: 'a'.repeat(129) })).toThrow(
      'TIKTOK_ADS_APP_SECRET',
    );
    expect(() => parseTikTokAdsEnv({ ...full, TIKTOK_ADS_CONNECTOR_ENABLED: 'yes' })).toThrow(
      EnvError,
    );
  });
});
