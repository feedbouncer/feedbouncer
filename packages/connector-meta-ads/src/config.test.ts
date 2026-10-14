import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { parseMetaAdsEnv } from './config.js';

const fb = {
  appId: '1234567',
  appSecret: {} as never,
  graphVersion: 'v26.0',
  webhookVerifyToken: {} as never,
};
const on = { META_ADS_CONNECTOR_ENABLED: 'true' };

describe('parseMetaAdsEnv', () => {
  it('is off by default and when false', () => {
    expect(parseMetaAdsEnv({}, fb)).toBeNull();
    expect(parseMetaAdsEnv({ META_ADS_CONNECTOR_ENABLED: 'false' }, fb)).toBeNull();
  });
  it('refuses to enable without facebook', () => {
    expect(() => parseMetaAdsEnv(on, null)).toThrow(EnvError);
    expect(() => parseMetaAdsEnv(on, null)).toThrow(/FACEBOOK_APP_ID/);
  });
  it('rejects junk flag values', () =>
    expect(() => parseMetaAdsEnv({ META_ADS_CONNECTOR_ENABLED: 'yes' }, fb)).toThrow(EnvError));
  it('defaults active statuses to ACTIVE', () =>
    expect(parseMetaAdsEnv(on, fb)).toEqual({ meta: fb, activeStatuses: ['ACTIVE'] }));
  it('parses a valid status list', () =>
    expect(
      parseMetaAdsEnv({ ...on, META_ADS_ACTIVE_STATUSES: 'ACTIVE,IN_PROCESS' }, fb)?.activeStatuses,
    ).toEqual(['ACTIVE', 'IN_PROCESS']));
  it.each(['active', 'ACTIVE;DROP', 'ACTIVE,', 'A,B,C,D,E,F,G,H,I,J,K'])('rejects %j', (v) =>
    expect(() => parseMetaAdsEnv({ ...on, META_ADS_ACTIVE_STATUSES: v }, fb)).toThrow(EnvError),
  );
});
