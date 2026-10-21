import type { OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createProducerConnection } from '@feedbouncer/jobs';
import { enqueuePrivacyRequest, PRIVACY_QUEUE } from '@feedbouncer/privacy';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

/** How long closing may wait for Redis before the connection is dropped anyway. */
const CLOSE_WAIT_MS = 1_000;

/** Puts privacy request ids on the queue the worker consumes; no identifiers travel over it. */
export class PrivacyQueueClient implements OnModuleDestroy {
  readonly #redis: Redis;
  readonly #queue: Queue;

  constructor(o: { redisUrl: string; prefix: string; log: Logger }) {
    this.#redis = createProducerConnection(o.redisUrl);
    this.#redis.on('error', (err) => o.log.warn('privacy.redis_error', errorFields(err)));
    this.#queue = new Queue(PRIVACY_QUEUE, { connection: this.#redis, prefix: o.prefix });
    this.#queue.on('error', (err) => o.log.warn('privacy.queue_error', errorFields(err)));
  }

  async enqueue(requestId: string): Promise<void> {
    await enqueuePrivacyRequest(this.#queue, requestId);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([
      this.#queue.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS)),
    ]);
    this.#redis.disconnect();
  }
}
