import { describe, expect, it } from 'vitest';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { buildConnectorRegistry, buildJobRegistry, type WorkerJobDeps } from './registries.js';

const cfg: FacebookConfig = {
  appId: '1234567890',
  appSecret: new Secret('app-secret-0123456789'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789abcdef'),
};

const fakeDeps = {
  runtime: {},
  directory: {},
  store: {},
  pool: {},
  clock: { now: () => 0 },
  log: createLogger('test', 'error', () => {}),
  ingestObserver: { onIngested: () => {} },
} as unknown as WorkerJobDeps;

describe('buildConnectorRegistry', () => {
  it('registers facebook only when configured', () => {
    expect(buildConnectorRegistry({ facebook: null }).platforms()).toEqual([]);
    expect(buildConnectorRegistry({ facebook: cfg }).platforms()).toEqual(['facebook']);
  });
});

describe('buildJobRegistry', () => {
  it('registers the three comment jobs for facebook', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const t of ['comment_ingest', 'moderation_execute', 'connection_lifecycle'])
      expect(jobs.supports(t, 'facebook')).toBe(true);
  });
});
