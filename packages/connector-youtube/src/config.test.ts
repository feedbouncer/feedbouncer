import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { parseYouTubeEnv, YOUTUBE_FILE_VARS } from './config.js';

const full = {
  YOUTUBE_CONNECTOR_ENABLED: 'true',
  YOUTUBE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
  YOUTUBE_CLIENT_SECRET: 'GOCSPX-sentinel-secret-0123456789',
};

describe('parseYouTubeEnv', () => {
  it('is disabled unless YOUTUBE_CONNECTOR_ENABLED=true', () => {
    expect(parseYouTubeEnv({})).toBeNull();
    expect(parseYouTubeEnv({ ...full, YOUTUBE_CONNECTOR_ENABLED: 'false' })).toBeNull();
    expect(() => parseYouTubeEnv({ ...full, YOUTUBE_CONNECTOR_ENABLED: 'yes' })).toThrow(EnvError);
  });

  it('applies the defaults', () => {
    expect(parseYouTubeEnv(full)).toMatchObject({
      clientId: full.YOUTUBE_CLIENT_ID,
      projectDailyQuota: 10_000,
      projectHeadroomUnits: 1000,
      schedulerTickSec: 60,
      backlogCap: 5000,
    });
  });

  it('reads configured values', () => {
    const cfg = parseYouTubeEnv({
      ...full,
      YOUTUBE_PROJECT_DAILY_QUOTA: '50000',
      YOUTUBE_PROJECT_HEADROOM_UNITS: '0',
      YOUTUBE_SCHEDULER_TICK_SEC: '10',
      YOUTUBE_BACKLOG_CAP: '100000',
    });
    expect(cfg).toMatchObject({
      projectDailyQuota: 50_000,
      projectHeadroomUnits: 0,
      schedulerTickSec: 10,
      backlogCap: 100_000,
    });
  });

  it.each(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'])(
    'enabled without %s fails fast, naming it but never a value',
    (name) => {
      const missing = { ...full, [name]: undefined };
      expect(() => parseYouTubeEnv(missing)).toThrow(name);
      expect(() => parseYouTubeEnv(missing)).toThrow(EnvError);
    },
  );

  it('does not show a short secret in the error', () => {
    const bad = { ...full, YOUTUBE_CLIENT_SECRET: 'tiny' };
    expect(() => parseYouTubeEnv(bad)).toThrow('YOUTUBE_CLIENT_SECRET');
    expect(() => parseYouTubeEnv(bad)).not.toThrow(/tiny/);
  });

  it.each([
    ['YOUTUBE_PROJECT_DAILY_QUOTA', '0'],
    ['YOUTUBE_PROJECT_DAILY_QUOTA', '1.5'],
    ['YOUTUBE_PROJECT_HEADROOM_UNITS', '-1'],
    ['YOUTUBE_SCHEDULER_TICK_SEC', '9'],
    ['YOUTUBE_SCHEDULER_TICK_SEC', '601'],
    ['YOUTUBE_BACKLOG_CAP', '99'],
    ['YOUTUBE_BACKLOG_CAP', '100001'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseYouTubeEnv({ ...full, [name]: value })).toThrow(name);
  });

  it('rejects headroom that leaves no quota', () => {
    const at = {
      ...full,
      YOUTUBE_PROJECT_DAILY_QUOTA: '5000',
      YOUTUBE_PROJECT_HEADROOM_UNITS: '5000',
    };
    expect(() => parseYouTubeEnv(at)).toThrow('YOUTUBE_PROJECT_HEADROOM_UNITS');
    expect(() => parseYouTubeEnv({ ...at, YOUTUBE_PROJECT_HEADROOM_UNITS: '4999' })).not.toThrow();
    // The default headroom must fit under a small quota too.
    expect(() => parseYouTubeEnv({ ...full, YOUTUBE_PROJECT_DAILY_QUOTA: '1000' })).toThrow(
      'YOUTUBE_PROJECT_HEADROOM_UNITS',
    );
  });

  it('keeps the secret out of JSON and inspect output', () => {
    const cfg = parseYouTubeEnv(full);
    expect(JSON.stringify(cfg)).not.toContain(full.YOUTUBE_CLIENT_SECRET);
    expect(inspect(cfg, { depth: 5 })).not.toContain(full.YOUTUBE_CLIENT_SECRET);
    expect(cfg?.clientSecret.reveal()).toBe(full.YOUTUBE_CLIENT_SECRET);
  });

  it('allows the secret from a file', () => {
    expect(YOUTUBE_FILE_VARS).toEqual(['YOUTUBE_CLIENT_SECRET']);
  });
});
