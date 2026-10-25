import {
  ActionRunner,
  ActionStepOutcomeObserver,
  PgActionRunStore,
  PgReviewQueue,
  PgSuggestionStore,
  actionRunAdvanceJob,
  loadBrandName,
  loadConnectionInfo,
  suggestionBulkJob,
  recordAudit,
} from '@feedbouncer/actions';
import {
  ClassifierActionFallback,
  ClassifierTrigger,
  PgClassificationStore,
  PgThresholdStore,
  classifyCommentJob,
  classifierRerunJob,
  createClassifierProvider,
  type ClassifierConfig,
} from '@feedbouncer/classifier';
import { createFacebookConnector, type FacebookConfig } from '@feedbouncer/connector-facebook';
import { createInstagramConnector, type InstagramConfig } from '@feedbouncer/connector-instagram';
import { createMetaAdsConnector, type MetaAdsConfig } from '@feedbouncer/connector-meta-ads';
import { createTikTokConnector, type TikTokConfig } from '@feedbouncer/connector-tiktok';
import { createTikTokAdsConnector, type TikTokAdsConfig } from '@feedbouncer/connector-tiktok-ads';
import { createYouTubeConnector, type YouTubeEnvConfig } from '@feedbouncer/connector-youtube';
import {
  adDiscoveryJob,
  adPollJob,
  connectionBackfillJob,
  PgAdTracking,
  PgBackfillStore,
  PgTikTokPolling,
  PgYouTubeBacklog,
  PgYouTubeSettings,
  PgYouTubeState,
  YouTubeNotices,
  youtubeCycleJob,
  type PgYouTubeQuotaLedger,
  type PollSettings,
  type TikTokPollPlatform,
  type TikTokPollSettings,
  tiktokAdsPollJob,
  tiktokPollJob,
  CompositeActionOutcomeObserver,
  executeActionJob,
  ingestCommentJob,
  connectionLifecycleJob,
  type IngestObserver,
  ModerationActions,
  PgReviewModeReader,
  type PgCommentStore,
} from '@feedbouncer/comments';
import {
  ConnectorRegistry,
  type Clock,
  type ConnectionDirectory,
  type ConnectorCapabilities,
  type ConnectorRuntime,
  type Platform,
} from '@feedbouncer/connectors';
import { BrandSlots, type createPool } from '@feedbouncer/db';
import { JobRegistry, type JobProducer } from '@feedbouncer/jobs';
import type { Mailer } from '@feedbouncer/mailer';
import {
  PgEvaluationStore,
  PgRuleStore,
  CompositeRuleEvaluatedHook,
  RuleActionFallback,
  RuleSetCache,
  RuleStepFallback,
  RuleTrigger,
  ruleEvaluateJob,
} from '@feedbouncer/rules';
import {
  PgPolicyEvaluationStore,
  PgPolicyPreviewStore,
  PgPolicyStore,
  PgPolicyUsage,
  POLICY_PREVIEW_JOB,
  PolicyActionFallback,
  PolicyTrigger,
  createPolicyEvaluator,
  policyEvaluateJob,
  policyPreviewJob,
  policyRunJob,
  type PolicyConfig,
} from '@feedbouncer/policies';
import type { Logger } from '@feedbouncer/service-runtime';

/** What the comment jobs need; built once in main.ts from the connector stack. */
export interface WorkerJobDeps {
  readonly runtime: ConnectorRuntime;
  readonly directory: ConnectionDirectory;
  readonly store: PgCommentStore;
  readonly pool: ReturnType<typeof createPool>;
  /** Dedicated pool for per-brand slot sessions, which hold a connection for the whole provider call. */
  readonly slotsPool: ReturnType<typeof createPool>;
  readonly classifier: ClassifierConfig;
  readonly policy: PolicyConfig;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ingestObserver: IngestObserver;
  /** Enqueues the resync ingest the execute job requests after platform-decided outcomes. */
  readonly producer: Pick<JobProducer, 'enqueue'>;
  /** Capabilities of the registered connectors; rule-initiated actions are checked against them. */
  readonly capabilities: (p: Platform) => ConnectorCapabilities | undefined;
  /** Set when the Meta Ads connector is enabled: registers ad discovery and ad polling. */
  readonly ads?: { readonly poll: PollSettings };
  /** Set when a TikTok connector is enabled: registers the poll job of each listed platform. */
  readonly tiktok?: {
    readonly settings: TikTokPollSettings;
    readonly platforms: readonly TikTokPollPlatform[];
  };
  /** Set when the YouTube connector is enabled: registers the cycle job and budgeted dispatch. */
  readonly youtube?: {
    readonly ledger: PgYouTubeQuotaLedger;
    readonly backlogCap: number;
    /** Sends the once-a-day quota notices to the organization's owners. */
    readonly mailer: Mailer;
    readonly publicWebUrl: URL;
  };
}

/** Platform connectors this deployment runs. Each registered platform gets its own queue. */
export function buildConnectorRegistry(cfg: {
  facebook: FacebookConfig | null;
  instagram: InstagramConfig | null;
  metaAds: MetaAdsConfig | null;
  tiktok?: TikTokConfig | null;
  tiktokAds?: TikTokAdsConfig | null;
  youtube?: YouTubeEnvConfig | null;
}): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  if (cfg.facebook) registry.register(createFacebookConnector(cfg.facebook));
  if (cfg.instagram) registry.register(createInstagramConnector(cfg.instagram));
  if (cfg.metaAds) registry.register(createMetaAdsConnector(cfg.metaAds));
  if (cfg.tiktok) registry.register(createTikTokConnector(cfg.tiktok));
  if (cfg.tiktokAds) registry.register(createTikTokAdsConnector(cfg.tiktokAds));
  if (cfg.youtube) registry.register(createYouTubeConnector(cfg.youtube));
  return registry;
}

/** Job types the worker executes. See docs/jobs/defining-a-job.md. */
export function buildJobRegistry(deps: WorkerJobDeps): JobRegistry {
  const registry = new JobRegistry();
  // Live comments whose text is new are evaluated against the brand's rules.
  const applied = new RuleTrigger(deps.producer);
  const evaluations = new PgEvaluationStore(deps.pool);
  registry.register(
    ingestCommentJob({
      runtime: deps.runtime,
      directory: deps.directory,
      store: deps.store,
      clock: deps.clock,
      observer: deps.ingestObserver,
      applied,
    }),
  );
  const classifications = new PgClassificationStore(deps.pool);
  const policyEvaluations = new PgPolicyEvaluationStore(deps.pool);
  const runs = new PgActionRunStore(deps.pool);
  // Outcomes of platform-decided actions, from the execute job and from the YouTube backlog alike.
  const outcomes = new CompositeActionOutcomeObserver([
    new RuleActionFallback({ evaluations, log: deps.log }),
    new ClassifierActionFallback({ classifications, log: deps.log }),
    new PolicyActionFallback({ evaluations: policyEvaluations, log: deps.log }),
    new ActionStepOutcomeObserver({ runs, producer: deps.producer, log: deps.log }),
  ]);
  const youtubeBacklog = deps.youtube
    ? new PgYouTubeBacklog({
        pool: deps.pool,
        clock: deps.clock,
        cap: deps.youtube.backlogCap,
        log: deps.log,
        outcomes,
      })
    : null;
  const actions = new ModerationActions({
    pool: deps.pool,
    store: deps.store,
    producer: deps.producer,
    capabilities: deps.capabilities,
    clock: deps.clock,
    log: deps.log,
    ...(youtubeBacklog && { budgeted: youtubeBacklog }),
  });
  const policies = new PgPolicyStore(deps.pool);
  const rules = new PgRuleStore(deps.pool);
  const runner = new ActionRunner({
    pool: deps.pool,
    runs,
    review: new PgReviewQueue(deps.pool),
    comments: deps.store,
    actions,
    connection: (scope) => loadConnectionInfo(deps.pool, scope, deps.capabilities),
    brandName: (scope) => loadBrandName(deps.pool, scope),
    producer: deps.producer,
    clock: deps.clock,
    log: deps.log,
    observer: new RuleStepFallback({ evaluations, log: deps.log }),
  });
  registry.register(actionRunAdvanceJob(runner));
  const suggestions = new PgSuggestionStore(deps.pool);
  const reviewMode = new PgReviewModeReader(deps.pool, deps.clock);
  registry.register(
    suggestionBulkJob({
      pool: deps.pool,
      suggestions,
      runs,
      runner,
      producer: deps.producer,
      audit: recordAudit,
      clock: deps.clock,
      log: deps.log,
    }),
  );
  registry.register(
    ruleEvaluateJob({
      comments: deps.store,
      evaluations,
      cache: new RuleSetCache(rules),
      runner,
      suggestions,
      reviewMode,
      log: deps.log,
      evaluated: new CompositeRuleEvaluatedHook([
        new ClassifierTrigger(deps.producer),
        new PolicyTrigger(deps.producer, policies),
      ]),
    }),
  );
  registry.register(
    classifyCommentJob({
      comments: deps.store,
      ruleEvaluations: evaluations,
      classifications,
      thresholds: new PgThresholdStore(deps.pool),
      provider: createClassifierProvider(deps.classifier),
      slots: new BrandSlots(deps.slotsPool, deps.classifier.perBrandInFlight),
      actions,
      suggestions,
      reviewMode,
      languages: deps.classifier.languages,
      maxWaitMs: deps.classifier.maxWaitMs,
      log: deps.log,
    }),
  );
  registry.register(
    classifierRerunJob({ pool: deps.pool, producer: deps.producer, log: deps.log }),
  );
  const policyUsage = new PgPolicyUsage(deps.pool, deps.clock);
  const policySlots = new BrandSlots(deps.slotsPool, deps.policy.perBrandInFlight, 'fb.policy');
  const policyEvaluator = createPolicyEvaluator(deps.policy);
  registry.register(
    policyEvaluateJob({
      comments: deps.store,
      ruleEvaluations: evaluations,
      policies,
      evaluations: policyEvaluations,
      usage: policyUsage,
      evaluator: policyEvaluator,
      slots: policySlots,
      actions,
      suggestions,
      reviewMode,
      monthlyCallsPerBrand: deps.policy.monthlyCallsPerBrand,
      maxWaitMs: deps.policy.maxWaitMs,
      log: deps.log,
      clock: deps.clock,
    }),
  );
  registry.register(
    policyPreviewJob({
      comments: deps.store,
      previews: new PgPolicyPreviewStore(deps.pool, deps.clock),
      evaluator: policyEvaluator,
      slots: policySlots,
      usage: policyUsage,
      monthlyCallsPerBrand: deps.policy.monthlyCallsPerBrand,
      next: async (scope, platform, payload) => {
        await deps.producer.enqueue({ scope, platform, type: POLICY_PREVIEW_JOB.type, payload });
      },
    }),
  );
  registry.register(
    policyRunJob({ pool: deps.pool, policies, producer: deps.producer, clock: deps.clock }),
  );
  registry.register(
    executeActionJob({
      pool: deps.pool,
      runtime: deps.runtime,
      log: deps.log,
      producer: deps.producer,
      clock: deps.clock,
      outcomes,
    }),
  );
  registry.register(connectionLifecycleJob({ runtime: deps.runtime, log: deps.log }));
  registry.register(
    connectionBackfillJob({
      runtime: deps.runtime,
      directory: deps.directory,
      store: deps.store,
      backfill: new PgBackfillStore(deps.pool),
      producer: deps.producer,
      clock: deps.clock,
      observer: deps.ingestObserver,
    }),
  );
  if (deps.ads) {
    const tracking = new PgAdTracking(deps.pool, deps.store);
    registry.register(
      adDiscoveryJob({
        runtime: deps.runtime,
        directory: deps.directory,
        tracking,
        clock: deps.clock,
      }),
    );
    registry.register(
      adPollJob({
        runtime: deps.runtime,
        directory: deps.directory,
        store: deps.store,
        tracking,
        clock: deps.clock,
        settings: deps.ads.poll,
        observer: deps.ingestObserver,
        applied,
      }),
    );
  }
  if (deps.tiktok) {
    const pollDeps = {
      runtime: deps.runtime,
      polling: new PgTikTokPolling(deps.pool),
      store: deps.store,
      clock: () => new Date(deps.clock.now()),
      settings: deps.tiktok.settings,
      applied,
    };
    if (deps.tiktok.platforms.includes('tiktok')) registry.register(tiktokPollJob(pollDeps));
    if (deps.tiktok.platforms.includes('tiktok_ads')) registry.register(tiktokAdsPollJob(pollDeps));
  }
  if (deps.youtube && youtubeBacklog) {
    registry.register(
      youtubeCycleJob({
        pool: deps.pool,
        runtime: deps.runtime,
        state: new PgYouTubeState(deps.pool),
        settings: new PgYouTubeSettings(deps.pool),
        ledger: deps.youtube.ledger,
        backlog: youtubeBacklog,
        notices: new YouTubeNotices({
          pool: deps.pool,
          mailer: deps.youtube.mailer,
          publicWebUrl: deps.youtube.publicWebUrl,
          log: deps.log,
          clock: deps.clock,
        }),
        store: deps.store,
        producer: deps.producer,
        applied,
        outcomes,
        clock: deps.clock,
        log: deps.log,
      }),
    );
  }
  return registry;
}
