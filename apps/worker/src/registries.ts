import { createFacebookConnector, type FacebookConfig } from '@feedbouncer/connector-facebook';
import { createInstagramConnector, type InstagramConfig } from '@feedbouncer/connector-instagram';
import { createMetaAdsConnector, type MetaAdsConfig } from '@feedbouncer/connector-meta-ads';
import {
  adDiscoveryJob,
  adPollJob,
  PgAdTracking,
  type PollSettings,
  executeActionJob,
  ingestCommentJob,
  connectionLifecycleJob,
  type IngestObserver,
  type PgCommentStore,
} from '@feedbouncer/comments';
import {
  ConnectorRegistry,
  type Clock,
  type ConnectionDirectory,
  type ConnectorRuntime,
} from '@feedbouncer/connectors';
import type { createPool } from '@feedbouncer/db';
import { JobRegistry, type JobProducer } from '@feedbouncer/jobs';
import type { Logger } from '@feedbouncer/service-runtime';

/** What the comment jobs need; built once in main.ts from the connector stack. */
export interface WorkerJobDeps {
  readonly runtime: ConnectorRuntime;
  readonly directory: ConnectionDirectory;
  readonly store: PgCommentStore;
  readonly pool: ReturnType<typeof createPool>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly ingestObserver: IngestObserver;
  /** Enqueues the resync ingest the execute job requests after platform-decided outcomes. */
  readonly producer: Pick<JobProducer, 'enqueue'>;
  /** Set when the Meta Ads connector is enabled: registers ad discovery and ad polling. */
  readonly ads?: { readonly poll: PollSettings };
}

/** Platform connectors this deployment runs. Each registered platform gets its own queue. */
export function buildConnectorRegistry(cfg: {
  facebook: FacebookConfig | null;
  instagram: InstagramConfig | null;
  metaAds: MetaAdsConfig | null;
}): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  if (cfg.facebook) registry.register(createFacebookConnector(cfg.facebook));
  if (cfg.instagram) registry.register(createInstagramConnector(cfg.instagram));
  if (cfg.metaAds) registry.register(createMetaAdsConnector(cfg.metaAds));
  return registry;
}

/** Job types the worker executes. See docs/jobs/defining-a-job.md. */
export function buildJobRegistry(deps: WorkerJobDeps): JobRegistry {
  const registry = new JobRegistry();
  registry.register(
    ingestCommentJob({
      runtime: deps.runtime,
      directory: deps.directory,
      store: deps.store,
      clock: deps.clock,
      observer: deps.ingestObserver,
    }),
  );
  registry.register(
    executeActionJob({
      pool: deps.pool,
      runtime: deps.runtime,
      log: deps.log,
      producer: deps.producer,
      clock: deps.clock,
    }),
  );
  registry.register(connectionLifecycleJob({ runtime: deps.runtime, log: deps.log }));
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
      }),
    );
  }
  return registry;
}
