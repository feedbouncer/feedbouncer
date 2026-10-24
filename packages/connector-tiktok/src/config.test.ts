import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { parseTikTokEnv } from './config.js';

const full = {
  TIKTOK_CONNECTOR_ENABLED: 'true',
  TIKTOK_APP_ID: '7300000000000001',
  TIKTOK_APP_SECRET: 's3cr3t-'.repeat(4),
};

describe('parseTikTokEnv', () => {
  it('is disabled unless TIKTOK_CONNECTOR_ENABLED=true', () => {
    expect(parseTikTokEnv({})).toBeNull();
    expect(parseTikTokEnv({ ...full, TIKTOK_CONNECTOR_ENABLED: 'false' })).toBeNull();
  });
  it.each(['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET'])(
    'names %s but never its value when it is missing or malformed',
    (name) => {
      const missing = { ...full, [name]: undefined };
      expect(() => parseTikTokEnv(missing)).toThrow(EnvError);
      expect(() => parseTikTokEnv(missing)).toThrow(name);
      const bad = { ...full, [name]: name === 'TIKTOK_APP_ID' ? 'bad id!' : 'short' };
      expect(() => parseTikTokEnv(bad)).toThrow(name);
      expect(() => parseTikTokEnv(bad)).not.toThrow(/bad id!|short/);
    },
  );
  it('rejects a secret longer than 128 characters', () => {
    expect(() => parseTikTokEnv({ ...full, TIKTOK_APP_SECRET: 'a'.repeat(129) })).toThrow(
      'TIKTOK_APP_SECRET',
    );
  });
  it.each(['7300000000000001', 'aw9abc123XYZ'])('accepts app id %s', (id) => {
    expect(parseTikTokEnv({ ...full, TIKTOK_APP_ID: id })).toEqual({
      appId: id,
      appSecret: full.TIKTOK_APP_SECRET,
    });
  });
  it('rejects an unrecognised enabled flag', () => {
    expect(() => parseTikTokEnv({ ...full, TIKTOK_CONNECTOR_ENABLED: 'yes' })).toThrow(EnvError);
  });
});
