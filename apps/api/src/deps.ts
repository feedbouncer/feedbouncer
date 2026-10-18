import type { Type } from '@nestjs/common';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { ModerationActions, PgCommentStore } from '@feedbouncer/comments';
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
  /** The Meta connectors (Facebook, plus Instagram when enabled). Null when Facebook is not configured. */
  readonly connectors: { registry: ConnectorRegistry; stack: PgConnectorStack } | null;
  /** Enqueue-only job producer (the worker runs the jobs). Null when Facebook is not configured. */
  readonly producer: JobProducer | null;
  /** Replaces the network behind the Slack webhook client; tests only. */
  readonly alertsFetch?: typeof fetch;
  /** Extra controllers to mount; tests only. */
  readonly extraControllers?: readonly Type[];
  readonly comments: { store: PgCommentStore; actions: ModerationActions } | null;
}
