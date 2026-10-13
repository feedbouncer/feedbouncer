import { describe, expect, it } from 'vitest';
import { parseFacebookEnv } from './config.js';

const full = {
  FACEBOOK_APP_ID: '1234567890',
  FACEBOOK_APP_SECRET: 'a'.repeat(32),
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(24),
};

describe('parseFacebookEnv', () => {
  it('is disabled when FACEBOOK_APP_ID is unset', () => {
    expect(parseFacebookEnv({})).toBeNull();
  });
  it('parses a full config with the default version', () => {
    const c = parseFacebookEnv(full)!;
    expect(c.appId).toBe('1234567890');
    expect(c.graphVersion).toBe('v26.0');
    expect(c.appSecret.reveal()).toBe('a'.repeat(32));
    expect(JSON.stringify(c)).not.toContain('a'.repeat(32));
  });
  it('accepts a valid version override', () => {
    expect(parseFacebookEnv({ ...full, FACEBOOK_GRAPH_API_VERSION: 'v27.0' })!.graphVersion).toBe(
      'v27.0',
    );
  });
  it.each([
    ['non-numeric app id', { ...full, FACEBOOK_APP_ID: '12ab' }],
    ['missing secret', { FACEBOOK_APP_ID: '123456' }],
    ['short verify token', { ...full, FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'short' }],
    ['bad version', { ...full, FACEBOOK_GRAPH_API_VERSION: '26' }],
  ])('throws on %s without echoing values', (_n, env) => {
    expect(() => parseFacebookEnv(env)).toThrow();
    try {
      parseFacebookEnv(env);
    } catch (e) {
      expect(String(e)).not.toContain('a'.repeat(32));
    }
  });
});
