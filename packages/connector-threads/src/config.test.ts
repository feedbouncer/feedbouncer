import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import {
  parseThreadsEnv,
  THREADS_REQUIRED_SCOPES,
  THREADS_SCOPES,
  THREADS_SCOPE_PURPOSES,
} from './config.js';

const full = {
  THREADS_CONNECTOR_ENABLED: 'true',
  THREADS_APP_ID: '1234567890',
  THREADS_APP_SECRET: 'sentinel-app-secret-0123456789',
};

describe('parseThreadsEnv', () => {
  it('is null unless enabled', () => {
    expect(parseThreadsEnv({})).toBeNull();
    expect(parseThreadsEnv({ ...full, THREADS_CONNECTOR_ENABLED: 'false' })).toBeNull();
    expect(() => parseThreadsEnv({ ...full, THREADS_CONNECTOR_ENABLED: 'yes' })).toThrow(EnvError);
  });

  it('applies defaults', () => {
    expect(parseThreadsEnv(full)).toMatchObject({
      appId: '1234567890',
      webhookVerifyToken: null,
      pollIntervalSec: 600,
      discoveryIntervalSec: 900,
    });
  });

  it('enabled without a secret fails fast, naming it', () => {
    const bad = { ...full, THREADS_APP_SECRET: undefined };
    expect(() => parseThreadsEnv(bad)).toThrow(EnvError);
    expect(() => parseThreadsEnv(bad)).toThrow('THREADS_APP_SECRET');
  });

  it.each([undefined, 'abc', '1'.repeat(33)])('rejects app id %j', (v) =>
    expect(() => parseThreadsEnv({ ...full, THREADS_APP_ID: v })).toThrow('THREADS_APP_ID'),
  );

  it.each([
    ['THREADS_POLL_INTERVAL_SEC', '30'],
    ['THREADS_POLL_INTERVAL_SEC', '3601'],
    ['THREADS_DISCOVERY_INTERVAL_SEC', '299'],
    ['THREADS_DISCOVERY_INTERVAL_SEC', '21601'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseThreadsEnv({ ...full, [name]: value })).toThrow(EnvError);
    expect(() => parseThreadsEnv({ ...full, [name]: value })).toThrow(name);
  });

  it('reads tuned values and the optional verify token', () => {
    const cfg = parseThreadsEnv({
      ...full,
      THREADS_POLL_INTERVAL_SEC: '60',
      THREADS_DISCOVERY_INTERVAL_SEC: '21600',
      THREADS_WEBHOOK_VERIFY_TOKEN: 'verify-token-sentinel',
    });
    expect(cfg).toMatchObject({ pollIntervalSec: 60, discoveryIntervalSec: 21600 });
    expect(cfg?.webhookVerifyToken?.reveal()).toBe('verify-token-sentinel');
  });

  it('keeps secrets out of JSON and inspect output', () => {
    const cfg = parseThreadsEnv({ ...full, THREADS_WEBHOOK_VERIFY_TOKEN: 'verify-token-sentinel' });
    const shown = JSON.stringify(cfg) + inspect(cfg, { depth: 5 });
    expect(shown).not.toContain(full.THREADS_APP_SECRET);
    expect(shown).not.toContain('verify-token-sentinel');
  });
});

describe('scopes', () => {
  it('lists the exact scopes and a purpose for each', () => {
    expect(THREADS_SCOPES).toEqual([
      'threads_basic',
      'threads_read_replies',
      'threads_manage_replies',
      'threads_content_publish',
    ]);
    expect(THREADS_REQUIRED_SCOPES).toEqual(['threads_basic', 'threads_read_replies']);
    for (const s of THREADS_SCOPES) expect(THREADS_SCOPE_PURPOSES[s].length).toBeGreaterThan(10);
  });
});
