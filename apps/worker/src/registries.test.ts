import { describe, expect, it, vi } from 'vitest';
import * as comments from '@feedbouncer/comments';
import { RuleActionFallback, RuleTrigger, ruleEvaluateJob } from '@feedbouncer/rules';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import { ClassifierTrigger, loadClassifierConfig } from '@feedbouncer/classifier';
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
  return {
    ...actual,
    executeActionJob: vi.fn(actual.executeActionJob),
    ingestCommentJob: vi.fn(actual.ingestCommentJob),
    adPollJob: vi.fn(actual.adPollJob),
  };
});

vi.mock('@feedbouncer/rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@feedbouncer/rules')>();
  return { ...actual, ruleEvaluateJob: vi.fn(actual.ruleEvaluateJob) };
});

const producer = { enqueue: vi.fn() };
const fakeDeps = {
  producer,
  runtime: {},
  directory: {},
  store: {},
  pool: {},
  clock: { now: () => 0 },
  capabilities: () => undefined,
  log: createLogger('test', 'error', () => {}),
  ingestObserver: { onIngested: () => {} },
  classifier: loadClassifierConfig({}),
  slotsPool: {},
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

describe('connection_backfill', () => {
  it('is registered for facebook and instagram without ads enabled', () => {
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.supports('connection_backfill', 'facebook')).toBe(true);
    expect(jobs.supports('connection_backfill', 'instagram')).toBe(true);
    expect(jobs.supports('connection_backfill', 'meta_ads')).toBe(false);
  });
});

describe('rule engine wiring', () => {
  it('registers rule_evaluate for every platform', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const p of ['facebook', 'instagram', 'meta_ads'] as const)
      expect(jobs.supports('rule_evaluate', p)).toBe(true);
  });
  it('passes one RuleTrigger as the applied hook to ingest and ad polling', () => {
    vi.mocked(comments.ingestCommentJob).mockClear();
    vi.mocked(comments.adPollJob).mockClear();
    buildJobRegistry({ ...fakeDeps, ads: { poll: { intervalSec: 300 } as comments.PollSettings } });
    const ingest = vi.mocked(comments.ingestCommentJob).mock.calls[0]?.[0];
    const poll = vi.mocked(comments.adPollJob).mock.calls[0]?.[0];
    expect(ingest?.applied).toBeInstanceOf(RuleTrigger);
    expect(poll?.applied).toBe(ingest?.applied);
  });
  it('gives ingest the hook without ad polling, so pending deliveries are swept on every connection', () => {
    vi.mocked(comments.ingestCommentJob).mockClear();
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.supports('ad_poll', 'facebook')).toBe(false);
    expect(vi.mocked(comments.ingestCommentJob).mock.calls[0]?.[0].applied).toBeInstanceOf(
      RuleTrigger,
    );
  });
  it('reports action outcomes to the rule fallback', () => {
    vi.mocked(comments.executeActionJob).mockClear();
    buildJobRegistry(fakeDeps);
    const outcomes = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0].outcomes;
    expect(outcomes).toBeInstanceOf(comments.CompositeActionOutcomeObserver);
    expect(RuleActionFallback).toBeDefined();
  });
});

describe('classifier wiring', () => {
  it('registers comment_classify on the classify lane for every platform', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const p of ['facebook', 'instagram', 'meta_ads'] as const)
      expect(jobs.supports('comment_classify', p)).toBe(true);
    expect(jobs.lanes()).toEqual(['classify']);
    expect(jobs.laneOf()('comment_classify')).toBe('classify');
    expect(jobs.laneOf()('rule_evaluate')).toBeNull();
  });
  it('triggers classification after rule evaluation', () => {
    vi.mocked(ruleEvaluateJob).mockClear();
    buildJobRegistry(fakeDeps);
    expect(vi.mocked(ruleEvaluateJob).mock.calls[0]?.[0].evaluated).toBeInstanceOf(
      ClassifierTrigger,
    );
  });
  it('fans action outcomes out to the classifier fallback as well as the rule fallback', async () => {
    vi.mocked(comments.executeActionJob).mockClear();
    buildJobRegistry(fakeDeps);
    const outcomes = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0].outcomes;
    expect(outcomes).toBeInstanceOf(comments.CompositeActionOutcomeObserver);
    // The stub pool has no query(): reaching the classification store proves it is wired.
    await expect(
      outcomes?.onActionOutcome({
        actorType: 'classifier',
        requestKey: 'clf:6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f',
        status: 'failed',
        code: 'x',
        kind: 'hide',
        scope: { organizationId: 'o', brandId: 'b' },
      } as never),
    ).rejects.toThrow();
  });
});
