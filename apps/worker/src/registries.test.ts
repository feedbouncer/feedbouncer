import { describe, expect, it, vi } from 'vitest';
import * as comments from '@feedbouncer/comments';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { buildConnectorRegistry, buildJobRegistry, type WorkerJobDeps } from './registries.js';

const cfg: FacebookConfig = {
  appId: '1234567890',
  appSecret: new Secret('app-secret-0123456789'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789abcdef'),
};

// Spy on executeActionJob while keeping the real implementation.
vi.mock('@feedbouncer/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@feedbouncer/comments')>();
  return { ...actual, executeActionJob: vi.fn(actual.executeActionJob) };
});

const producer = { enqueue: vi.fn() };
const fakeDeps = {
  producer,
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
    expect(
      buildConnectorRegistry({ facebook: null, instagram: null, metaAds: null }).platforms(),
    ).toEqual([]);
    expect(
      buildConnectorRegistry({ facebook: cfg, instagram: null, metaAds: null }).platforms(),
    ).toEqual(['facebook']);
  });
  it('registers instagram only when enabled', () => {
    expect(
      buildConnectorRegistry({ facebook: cfg, instagram: null, metaAds: null }).platforms(),
    ).toEqual(['facebook']);
    expect(
      buildConnectorRegistry({ facebook: cfg, instagram: { meta: cfg }, metaAds: null })
        .platforms()
        .slice()
        .sort(),
    ).toEqual(['facebook', 'instagram']);
  });
});

describe('meta ads', () => {
  it('registers the meta_ads connector only when enabled', () => {
    const metaAds = { meta: cfg, activeStatuses: ['ACTIVE'] };
    expect(
      buildConnectorRegistry({ facebook: cfg, instagram: null, metaAds }).platforms().sort(),
    ).toEqual(['facebook', 'meta_ads']);
  });
  it('registers ad_discovery and ad_poll only when ad polling is enabled', () => {
    const off = buildJobRegistry(fakeDeps);
    expect(off.supports('ad_discovery', 'meta_ads')).toBe(false);
    expect(off.supports('ad_poll', 'facebook')).toBe(false);
    const on = buildJobRegistry({
      ...fakeDeps,
      ads: { poll: { intervalSec: 300 } as comments.PollSettings },
    });
    expect(on.supports('ad_discovery', 'meta_ads')).toBe(true);
    expect(on.supports('ad_poll', 'facebook')).toBe(true);
    expect(on.supports('ad_poll', 'instagram')).toBe(true);
  });
});

describe('buildJobRegistry', () => {
  it('registers the three comment jobs for facebook', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const t of ['comment_ingest', 'moderation_execute', 'connection_lifecycle'])
      expect(jobs.supports(t, 'facebook')).toBe(true);
  });
  it('registers the three comment jobs for instagram', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const t of ['comment_ingest', 'moderation_execute', 'connection_lifecycle'])
      expect(jobs.supports(t, 'instagram')).toBe(true);
  });
  it('passes the producer to the execute job', () => {
    buildJobRegistry(fakeDeps);
    expect(comments.executeActionJob).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0];
    expect(arg?.producer).toBe(producer);
  });
});
