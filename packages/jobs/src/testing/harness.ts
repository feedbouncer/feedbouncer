import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { ConnectorRegistry } from '@feedbouncer/connectors';
import { createReferenceConnector, InMemoryPlatform } from '@feedbouncer/connectors/testing';
import { createPool } from '@feedbouncer/db';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger, type Logger } from '@feedbouncer/service-runtime';
import { loadJobsConfig, type JobsConfig } from '../config.js';
import { createProducerConnection } from '../connections.js';
import { JobRegistry } from '../definition.js';
import { PgJobLedger, type LedgerDetail, type LedgerState } from '../ledger.js';
import { JobMetrics } from '../metrics.js';
import { JobProducer } from '../producer.js';
import { QueueSet } from '../queues.js';
import { JobWorkers, type JobWorkersDeps } from '../workers.js';
import { closeJobsDatabase, jobsDatabase, seedJobsTenant, type JobsTenant } from './db.js';
import { testRedis, type TestRedis } from './redis.js';
import { ScriptedJob } from './scripted-job.js';

export interface JobsHarness {
  readonly pool: pg.Pool;
  readonly redis: TestRedis;
  readonly tenants: readonly [JobsTenant, JobsTenant];
  /** Reference facebook (push) and youtube (poll). */
  readonly connectors: ConnectorRegistry;
  /** `scripted` registered. */
  readonly jobs: JobRegistry;
  readonly script: ScriptedJob;
  readonly config: JobsConfig;
  readonly ledger: PgJobLedger;
  readonly producer: JobProducer;
  readonly metrics: JobMetrics;
  /** Every log line from producer, workers and metrics. */
  readonly lines: string[];
  readonly log: Logger;
  scope(i: 0 | 1, platform: 'facebook' | 'youtube'): ConnectionScope;
  /** Started; closed in cleanup. */
  workers(over?: Partial<JobWorkersDeps>): Promise<JobWorkers>;
  waitFor(id: string, states: LedgerState[], timeoutMs?: number): Promise<LedgerDetail>;
  cleanup(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createJobsHarness(): Promise<JobsHarness> {
  const db = await jobsDatabase();
  const label = () => `h-${randomBytes(4).toString('hex')}`;
  const tenants = [await seedJobsTenant(db, label()), await seedJobsTenant(db, label())] as const;
  const pool = createPool(db.db.url, { applicationName: 'jobs-harness', onIdleError: () => {} });
  const redis = testRedis();
  const producerConnection = createProducerConnection(redis.url);
  producerConnection.on('error', () => {});

  const redirectUri = 'https://app.feedbouncer.test/oauth/callback';
  const platform = () =>
    new InMemoryPlatform({
      clock: { now: () => Date.now() },
      rotateRefreshTokens: true,
      accessTokenTtlMs: 3_600_000,
      webhookSecret: 'whsec-test-only',
      redirectUri,
    });
  const connectors = new ConnectorRegistry();
  connectors.register(createReferenceConnector(platform(), { flavor: 'push', redirectUri }));
  connectors.register(createReferenceConnector(platform(), { flavor: 'poll', redirectUri }));

  const script = new ScriptedJob();
  const jobs = new JobRegistry();
  jobs.register(script.definition());

  const config: JobsConfig = {
    ...loadJobsConfig({}),
    prefix: redis.prefix,
    defaultPolicy: {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 800,
      maxDeferrals: 5,
      maxDeferredMs: 20_000,
    },
    bull: { lockDurationMs: 1_000, stalledIntervalMs: 500 },
    sweepIntervalMs: 200,
    staleAfterMs: 500,
    dlqRetentionMs: 3_600_000,
    dedupWindowMs: 86_400_000,
  };

  const lines: string[] = [];
  const log = createLogger('jobs-test', 'debug', (l) => lines.push(l));
  const metrics = new JobMetrics(log);
  const ledger = new PgJobLedger(pool);
  const queues = new QueueSet({ connection: producerConnection, prefix: config.prefix });
  const producer = new JobProducer({
    ledger,
    jobs,
    connectors,
    queues,
    metrics,
    dedupWindowMs: config.dedupWindowMs,
  });

  const started: JobWorkers[] = [];
  let n = 0;

  return {
    pool,
    redis,
    tenants,
    connectors,
    jobs,
    script,
    config,
    ledger,
    producer,
    metrics,
    lines,
    log,
    scope(i, p) {
      const t = tenants[i];
      return {
        organizationId: t.organizationId,
        brandId: t.brandId,
        connectionId: p === 'youtube' ? t.youtubeConnectionId : t.connectionId,
      };
    },
    async workers(over = {}) {
      const w = new JobWorkers({
        connection: redis.connection,
        ledger,
        producer,
        jobs,
        connectors,
        config,
        workerId: `harness-${++n}`,
        log,
        metrics,
        ...over,
      });
      started.push(w);
      await w.start();
      return w;
    },
    async waitFor(id, states, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let last: LedgerDetail | null = null;
      for (;;) {
        last = await ledger.get(id);
        if (last && states.includes(last.state)) return last;
        if (Date.now() > deadline) {
          throw new Error(
            `job ${id} did not reach ${states.join('|')} within ${timeoutMs} ms (state: ${last?.state ?? 'missing'})`,
          );
        }
        await sleep(50);
      }
    },
    async cleanup() {
      await Promise.all(started.map((w) => w.close()));
      await queues.close();
      producerConnection.disconnect();
      await pool.end();
      await redis.cleanup();
      await closeJobsDatabase();
    },
  };
}
