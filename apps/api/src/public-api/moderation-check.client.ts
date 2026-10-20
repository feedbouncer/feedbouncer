import { randomUUID } from 'node:crypto';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  ADD_TIMEOUT_MS,
  createProducerConnection,
  createWorkerConnection,
} from '@feedbouncer/jobs';
import {
  CHECK_JOB_FAILURES,
  MODERATION_CHECK_QUEUE,
  type CheckJobData,
  type CheckJobResult,
} from '@feedbouncer/moderation-check';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

const JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true } as const;
/** How long a failed run waits for its job to be removed before answering. */
const REMOVE_WAIT_MS = 1_000;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('moderation check timed out')), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const isWorkerFailure = (err: unknown) =>
  err instanceof Error && (CHECK_JOB_FAILURES as readonly string[]).includes(err.message);

/**
 * Hands text to the worker over the moderation-check queue and waits for its
 * verdict. The text lives in Redis only until the job finishes or is removed.
 */
export class ModerationCheckClient implements OnModuleInit, OnModuleDestroy {
  #connections: Redis[] = [];
  #queue: Queue | null = null;
  #events: QueueEvents | null = null;

  constructor(private readonly o: { redisUrl: string; prefix: string; log: Logger }) {}

  onModuleInit(): Promise<void> {
    return this.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  async start(): Promise<void> {
    const onError = (err: unknown) =>
      this.o.log.warn('moderation_check.redis_error', errorFields(err));
    // Commands fail fast on the producer side; QueueEvents blocks and must wait out outages.
    const producer = createProducerConnection(this.o.redisUrl);
    const listener = createWorkerConnection(this.o.redisUrl);
    for (const c of [producer, listener]) c.on('error', onError);
    this.#connections = [producer, listener];
    this.#queue = new Queue(MODERATION_CHECK_QUEUE, {
      connection: producer,
      prefix: this.o.prefix,
    });
    this.#events = new QueueEvents(MODERATION_CHECK_QUEUE, {
      connection: listener,
      prefix: this.o.prefix,
    });
    this.#queue.on('error', () => {});
    this.#events.on('error', () => {});
    // Bounded so an unreachable Redis does not hold up startup; each run waits for the listener too.
    await within(ADD_TIMEOUT_MS, this.#events.waitUntilReady()).catch(() =>
      this.o.log.warn('moderation_check.not_ready'),
    );
  }

  async stop(): Promise<void> {
    // Closing waits for Redis, so it is bounded; the connections are dropped either way.
    await within(
      REMOVE_WAIT_MS,
      Promise.allSettled([this.#events?.close(), this.#queue?.close()]),
    ).catch(() => {});
    for (const c of this.#connections) c.disconnect();
    this.#connections = [];
    this.#queue = this.#events = null;
  }

  /**
   * The worker's answer, 'unavailable' when there was none within `ttlMs`, or 'failed' when
   * the worker gave up on the job. Never rejects.
   */
  async run(data: CheckJobData, ttlMs: number): Promise<CheckJobResult | 'unavailable' | 'failed'> {
    const deadline = Date.now() + ttlMs;
    const jobId = randomUUID();
    const queue = this.#queue;
    const events = this.#events;
    const added = queue
      ? queue.add('check', data, { ...JOB_OPTIONS, jobId })
      : Promise.reject(new Error('moderation check client is not started'));
    added.catch(() => {});
    try {
      const job = await within(Math.min(ADD_TIMEOUT_MS, ttlMs), added);
      return (await job.waitUntilFinished(
        events!,
        Math.max(1, deadline - Date.now()),
      )) as CheckJobResult;
    } catch (err) {
      if (isWorkerFailure(err)) {
        this.o.log.error('moderation_check.failed', { jobId });
        return 'failed';
      }
      // An add that lands late is removed as soon as it does. An active job cannot be
      // removed; the worker removes it when it finishes.
      await within(
        REMOVE_WAIT_MS,
        added.then((job) => job.remove()),
      ).catch(() => {});
      this.o.log.warn('moderation_check.unavailable', { jobId });
      return 'unavailable';
    }
  }
}
