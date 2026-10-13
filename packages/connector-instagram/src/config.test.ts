import { describe, expect, it } from 'vitest';
import { parseInstagramEnv } from './config.js';

const fb = {
  appId: '1234567',
  appSecret: {} as never,
  graphVersion: 'v26.0',
  webhookVerifyToken: {} as never,
};

describe('parseInstagramEnv', () => {
  it('is off by default', () => expect(parseInstagramEnv({}, fb)).toBeNull());
  it('is off when false', () =>
    expect(parseInstagramEnv({ INSTAGRAM_CONNECTOR_ENABLED: 'false' }, fb)).toBeNull());
  it('reuses the Meta app config when on', () =>
    expect(parseInstagramEnv({ INSTAGRAM_CONNECTOR_ENABLED: 'true' }, fb)).toEqual({ meta: fb }));
  it('refuses to enable without facebook', () =>
    expect(() => parseInstagramEnv({ INSTAGRAM_CONNECTOR_ENABLED: 'true' }, null)).toThrow(
      /FACEBOOK_APP_ID/,
    ));
  it('rejects junk values', () =>
    expect(() => parseInstagramEnv({ INSTAGRAM_CONNECTOR_ENABLED: 'yes' }, fb)).toThrow(
      /INSTAGRAM_CONNECTOR_ENABLED/,
    ));
});
