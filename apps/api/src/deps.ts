import type pg from 'pg';
import type { Redis } from 'ioredis';
import type {
  ModerationActions,
  PgCommentStore,
  PgYouTubeBacklog,
  PgYouTubeQuotaLedger,
  PgYouTubeSettings,
} from '@feedbouncer/comments';
import type { ConnectorRegistry, PgConnectorStack } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { Mailer } from '@feedbouncer/mailer';
import type { FbMetrics, HealthReader } from '@feedbouncer/observability';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ApiEnv } from './env.js';

/** Process-level resources, created in main.ts (or the test harness) and owned there. */
export interface AppDeps {
  readonly env: ApiEnv;
  readonly pool: pg.Pool;
  readonly redis: Redis;
  readonly mailer: Mailer;
  readonly log: Logger;
  readonly metrics: FbMetrics;
  readonly health: HealthReader;
  /** Prepended to every Redis key the API writes, so tests can isolate and clean up. */
  readonly redisKeyPrefix: string;
  /** The configured platform connectors (Meta, TikTok, YouTube and Threads). Null when none is configured. */
  readonly connectors: { registry: ConnectorRegistry; stack: PgConnectorStack } | null;
  /** Enqueue-only job producer (the worker runs the jobs). Null when no connector is configured. */
  readonly producer: JobProducer | null;
  /** Replaces the network behind the Slack webhook client; tests only. */
  readonly alertsFetch?: typeof fetch;
  /** Replaces the network behind the free scan's Graph client; tests only. */
  readonly scanFetch?: typeof fetch;
  readonly comments: {
    store: PgCommentStore;
    actions: ModerationActions;
    /** Where YouTube actions wait for the budget; disconnecting abandons a connection's queue. */
    youtubeBacklog: PgYouTubeBacklog;
    /** The YouTube budget ledger and owner settings, shared by every request. The ledger is null unless YouTube is enabled. */
    youtubeLedger: PgYouTubeQuotaLedger | null;
    youtubeSettings: PgYouTubeSettings;
  } | null;
}
