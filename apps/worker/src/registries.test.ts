import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionStepOutcomeObserver } from '@feedbouncer/actions';
import * as comments from '@feedbouncer/comments';
import {
  CompositeRuleEvaluatedHook,
  RuleActionFallback,
  RuleTrigger,
  ruleEvaluateJob,
} from '@feedbouncer/rules';
import type { FacebookConfig } from '@feedbouncer/connector-facebook';
import {
  ClassifierActionFallback,
  ClassifierTrigger,
  loadClassifierConfig,
} from '@feedbouncer/classifier';
import { PolicyActionFallback, PolicyTrigger, loadPolicyConfig } from '@feedbouncer/policies';
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
    tiktokPollJob: vi.fn(actual.tiktokPollJob),
    tiktokAdsPollJob: vi.fn(actual.tiktokAdsPollJob),
    ModerationActions: vi.fn(actual.ModerationActions),
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
  policy: loadPolicyConfig({}),
  slotsPool: {},
} as unknown as WorkerJobDeps;

// Action outcomes also reach the step observer, which would query the fake pool.
let stepOutcome: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stepOutcome = vi
    .spyOn(ActionStepOutcomeObserver.prototype, 'onActionOutcome')
    .mockResolvedValue();
});
afterEach(() => stepOutcome.mockRestore());

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

describe('tiktok', () => {
  const tiktok = { appId: '7300000000000001', appSecret: new Secret('tiktok-secret-0123456789') };
  const settings = { pollIntervalSec: 300 } as comments.TikTokPollSettings;

  it('tiktok connectors and jobs register without Facebook config', () => {
    const connectors = buildConnectorRegistry({
      facebook: null,
      instagram: null,
      metaAds: null,
      tiktok,
      tiktokAds: tiktok,
    });
    expect(connectors.platforms().sort()).toEqual(['tiktok', 'tiktok_ads']);
    const jobs = buildJobRegistry({
      ...fakeDeps,
      tiktok: { settings, platforms: ['tiktok', 'tiktok_ads'] },
    });
    expect(jobs.supports('tiktok_poll', 'tiktok')).toBe(true);
    expect(jobs.supports('tiktok_ads_poll', 'tiktok_ads')).toBe(true);
    expect(jobs.supports('tiktok_poll', 'tiktok_ads')).toBe(false);
  });
  it('registers each poll job only for its enabled platform', () => {
    const jobs = buildJobRegistry({ ...fakeDeps, tiktok: { settings, platforms: ['tiktok_ads'] } });
    expect(jobs.supports('tiktok_ads_poll', 'tiktok_ads')).toBe(true);
    expect(jobs.get('tiktok_poll')).toBeUndefined();
    expect(
      buildConnectorRegistry({
        facebook: null,
        instagram: null,
        metaAds: null,
        tiktokAds: tiktok,
      }).platforms(),
    ).toEqual(['tiktok_ads']);
  });
  it('no tiktok env → no tiktok jobs, Meta unchanged', () => {
    const connectors = buildConnectorRegistry({ facebook: cfg, instagram: null, metaAds: null });
    expect(connectors.platforms()).toEqual(['facebook']);
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.get('tiktok_poll')).toBeUndefined();
    expect(jobs.get('tiktok_ads_poll')).toBeUndefined();
    expect(jobs.supports('comment_ingest', 'facebook')).toBe(true);
  });
  it('gives both poll jobs the same applied hook as ingest', () => {
    const tiktokPoll = vi.mocked(comments.tiktokPollJob);
    const tiktokAdsPoll = vi.mocked(comments.tiktokAdsPollJob);
    buildJobRegistry({ ...fakeDeps, tiktok: { settings, platforms: ['tiktok', 'tiktok_ads'] } });
    for (const spy of [tiktokPoll, tiktokAdsPoll]) {
      expect(spy.mock.calls.at(-1)![0].applied).toBeInstanceOf(RuleTrigger);
      expect(spy.mock.calls.at(-1)![0].settings).toBe(settings);
    }
  });
});

describe('youtube', () => {
  const youtube = {
    clientId: '123-abc.apps.googleusercontent.com',
    clientSecret: new Secret('youtube-secret-0123456789'),
    projectDailyQuota: 10_000,
    projectHeadroomUnits: 1000,
    schedulerTickSec: 60,
    backlogCap: 5000,
  };
  const meter = { reserve: vi.fn(), settle: vi.fn() };
  const ledger = { meterFor: vi.fn(() => meter) } as unknown as comments.PgYouTubeQuotaLedger;
  const withYouTube = {
    ...fakeDeps,
    youtube: { ledger, backlogCap: 250, mailer: {}, publicWebUrl: new URL('https://app.test') },
  } as unknown as WorkerJobDeps;

  it('registers the connector only when enabled', () => {
    const none = { facebook: null, instagram: null, metaAds: null };
    expect(buildConnectorRegistry(none).platforms()).toEqual([]);
    expect(buildConnectorRegistry({ ...none, youtube }).platforms()).toEqual(['youtube']);
  });
  it('registers youtube with budgeted dispatch and a quota meter', () => {
    vi.mocked(comments.ModerationActions).mockClear();
    const jobs = buildJobRegistry(withYouTube);
    expect(jobs.supports('youtube_cycle', 'youtube')).toBe(true);
    const actions = vi.mocked(comments.ModerationActions).mock.calls[0]![0];
    expect(actions.budgeted).toBeInstanceOf(comments.PgYouTubeBacklog);
    const scope = { organizationId: 'o', brandId: 'b', connectionId: 'c' };
    expect(comments.youtubeQuotaMeters(ledger)('youtube', scope)).toBe(meter);
    expect(ledger.meterFor).toHaveBeenCalledWith(scope);
    expect(comments.youtubeQuotaMeters(ledger)('tiktok', scope)).toBeUndefined();
  });
  it('without youtube there is no cycle job and no budgeted dispatch', () => {
    vi.mocked(comments.ModerationActions).mockClear();
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.get('youtube_cycle')).toBeUndefined();
    expect(vi.mocked(comments.ModerationActions).mock.calls[0]![0].budgeted).toBeUndefined();
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
  });
});

describe('action runs wiring', () => {
  it('registers action_run_advance for facebook and instagram', () => {
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.supports('action_run_advance', 'facebook')).toBe(true);
    expect(jobs.supports('action_run_advance', 'instagram')).toBe(true);
  });
  it('registers suggestion_bulk_apply for tiktok and tiktok_ads, so bulk review works there', () => {
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.supports('suggestion_bulk_apply', 'tiktok')).toBe(true);
    expect(jobs.supports('suggestion_bulk_apply', 'tiktok_ads')).toBe(true);
  });
  it('registers action_run_advance for tiktok and tiktok_ads, so rule steps on their comments run', () => {
    const jobs = buildJobRegistry(fakeDeps);
    expect(jobs.supports('action_run_advance', 'tiktok')).toBe(true);
    expect(jobs.supports('action_run_advance', 'tiktok_ads')).toBe(true);
  });
  it('wakes runs from platform action outcomes', async () => {
    vi.mocked(comments.executeActionJob).mockClear();
    buildJobRegistry(fakeDeps);
    const outcomes = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0].outcomes;
    const event = { actorType: 'user', requestKey: 'k', status: 'applied' } as never;
    await outcomes?.onActionOutcome(event);
    expect(stepOutcome).toHaveBeenCalledWith(event);
  });
});

describe('classifier wiring', () => {
  it('registers comment_classify on the classify lane for every platform', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const p of ['facebook', 'instagram', 'meta_ads'] as const)
      expect(jobs.supports('comment_classify', p)).toBe(true);
    expect(jobs.lanes()).toEqual(['classify', 'policy']);
    expect(jobs.laneOf()('comment_classify')).toBe('classify');
    expect(jobs.laneOf()('rule_evaluate')).toBeNull();
  });
  it('triggers classification after rule evaluation', () => {
    vi.mocked(ruleEvaluateJob).mockClear();
    buildJobRegistry(fakeDeps);
    expect(vi.mocked(ruleEvaluateJob).mock.calls[0]?.[0].evaluated).toBeInstanceOf(
      CompositeRuleEvaluatedHook,
    );
  });
  it('fans action outcomes out to both the rule fallback and the classifier fallback', async () => {
    const rule = vi.spyOn(RuleActionFallback.prototype, 'onActionOutcome').mockResolvedValue();
    const classifier = vi
      .spyOn(ClassifierActionFallback.prototype, 'onActionOutcome')
      .mockResolvedValue();
    try {
      vi.mocked(comments.executeActionJob).mockClear();
      buildJobRegistry(fakeDeps);
      const outcomes = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0].outcomes;
      expect(outcomes).toBeInstanceOf(comments.CompositeActionOutcomeObserver);
      const event = {
        actorType: 'classifier',
        requestKey: 'clf:6f1c2a4e-8d2b-4c3a-9b1e-0a1b2c3d4e5f',
        status: 'failed',
        code: 'x',
        kind: 'hide',
        scope: { organizationId: 'o', brandId: 'b' },
      } as never;
      await outcomes?.onActionOutcome(event);
      expect(rule).toHaveBeenCalledTimes(1);
      expect(classifier).toHaveBeenCalledTimes(1);
      expect(rule).toHaveBeenCalledWith(event);
      expect(classifier).toHaveBeenCalledWith(event);
    } finally {
      rule.mockRestore();
      classifier.mockRestore();
    }
  });
});

describe('policy wiring', () => {
  it('registers policy_evaluate and policy_preview on the policy lane and policy_run on none', () => {
    const jobs = buildJobRegistry(fakeDeps);
    for (const p of ['facebook', 'instagram', 'meta_ads'] as const)
      for (const t of ['policy_evaluate', 'policy_preview', 'policy_run'])
        expect(jobs.supports(t, p)).toBe(true);
    expect(jobs.laneOf()('policy_evaluate')).toBe('policy');
    expect(jobs.laneOf()('policy_preview')).toBe('policy');
    expect(jobs.laneOf()('policy_run')).toBeNull();
  });
  it('triggers both the classifier and the policy check after rule evaluation', async () => {
    const classifier = vi.spyOn(ClassifierTrigger.prototype, 'onEvaluated').mockResolvedValue();
    const policy = vi.spyOn(PolicyTrigger.prototype, 'onEvaluated').mockResolvedValue();
    try {
      vi.mocked(ruleEvaluateJob).mockClear();
      buildJobRegistry(fakeDeps);
      const hook = vi.mocked(ruleEvaluateJob).mock.calls[0]?.[0].evaluated;
      const event = { status: 'no_match' } as never;
      await hook?.onEvaluated(event);
      expect(classifier).toHaveBeenCalledWith(event);
      expect(policy).toHaveBeenCalledWith(event);
    } finally {
      classifier.mockRestore();
      policy.mockRestore();
    }
  });
  it('reports action outcomes to the policy fallback', async () => {
    const policy = vi.spyOn(PolicyActionFallback.prototype, 'onActionOutcome').mockResolvedValue();
    try {
      vi.mocked(comments.executeActionJob).mockClear();
      buildJobRegistry(fakeDeps);
      const outcomes = vi.mocked(comments.executeActionJob).mock.calls[0]?.[0].outcomes;
      const event = { actorType: 'policy', status: 'failed' } as never;
      await outcomes?.onActionOutcome(event);
      expect(policy).toHaveBeenCalledWith(event);
    } finally {
      policy.mockRestore();
    }
  });
});
