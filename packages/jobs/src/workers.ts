// One BullMQ Worker per platform queue, plus a sweeper that re-enqueues
// ledger rows whose Redis job went missing and purges expired rows. A slow or
// rate-limited platform only ever occupies its own queue's concurrency slots.
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ConnectorRegistry, Platform } from '@feedbouncer/connectors';
import type { Logger } from '@feedbouncer/service-runtime';
import { assertDedupWindow, policyResolver, type JobsConfig } from './config.js';
import type { JobRegistry } from './definition.js';
import type { PgJobLedger } from './ledger.js';
import type { JobMetrics } from './metrics.js';
import type { JobProducer } from './producer.js';
import { queueName } from './queues.js';
import { createJobProcessor } from './runner.js';

export interface JobWorkersDeps {
  /** ioredis with `maxRetriesPerRequest: null`; not shared with the producer. */
  readonly connection: Redis;
  readonly ledger: PgJobLedger;
  readonly producer: JobProducer;
  readonly jobs: JobRegistry;
  readonly connectors: ConnectorRegistry;
  readonly config: JobsConfig;
  readonly workerId: string;
  readonly log: Logger;
  readonly metrics: JobMetrics;
  /** Tests only. */
  readonly afterComplete?: (ledgerId: string) => Promise<void>;
}

export class JobWorkers {
  readonly #workers = new Map<Platform, Worker>();
  #timer: NodeJS.Timeout | undefined;
  #sweeping = false;

  constructor(private readonly d: JobWorkersDeps) {}

  async start(): Promise<void> {
    const { d } = this;
    const platforms = d.connectors.platforms().filter((p) => d.config.concurrency[p] > 0);
    assertDedupWindow(d.config, d.jobs, platforms);

    for (const p of platforms) {
      const w = new Worker(
        queueName(p),
        createJobProcessor({
          platform: p,
          ledger: d.ledger,
          jobs: d.jobs,
          metrics: d.metrics,
          log: d.log,
          workerId: d.workerId,
          dlqRetentionMs: d.config.dlqRetentionMs,
          policyFor: policyResolver(d.config, d.jobs, p),
          ...(d.afterComplete ? { afterComplete: d.afterComplete } : {}),
        }),
        {
          connection: d.connection,
          prefix: d.config.prefix,
          concurrency: d.config.concurrency[p],
          autorun: false,
          lockDuration: d.config.bull.lockDurationMs,
          stalledInterval: d.config.bull.stalledIntervalMs,
          // Redis stalls are bounded by the ledger's crash counter, not by BullMQ.
          maxStalledCount: 1_000,
        },
      );
      w.on('error', (e) => d.log.error('job worker error', { platform: p, errorName: e.name }));
      w.on('failed', (job, e) =>
        d.log.debug('job left queue', { platform: p, jobId: job?.id ?? null, errorName: e.name }),
      );
      this.#workers.set(p, w);
      w.run().catch((e: unknown) =>
        d.log.error('job worker stopped', {
          platform: p,
          errorName: e instanceof Error ? e.name : 'NonError',
        }),
      );
      await w.waitUntilReady();
    }

    void this.sweep();
    this.#timer = setInterval(() => void this.sweep(), d.config.sweepIntervalMs);
    this.#timer.unref();
  }

  platforms(): Platform[] {
    return [...this.#workers.keys()];
  }

  isRunning(): boolean {
    return [...this.#workers.values()].every((w) => w.isRunning());
  }

  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      const requeued = await this.d.producer.reconcile(this.d.config.staleAfterMs, 500);
      const purged = await this.d.ledger.purgeExpired(1_000);
      this.d.log.info('job.stats', { requeued, purged, ...this.#counts() });
    } catch (e) {
      this.d.log.error('job sweep failed', { errorName: e instanceof Error ? e.name : 'NonError' });
    } finally {
      this.#sweeping = false;
    }
  }

  #counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [platform, c] of Object.entries(this.d.metrics.snapshot())) {
      out[`${platform}_completed`] = c.completed;
      out[`${platform}_dead_lettered`] = c.dead_lettered;
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const all = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.all(all.map((w) => w.close()));
  }
}
