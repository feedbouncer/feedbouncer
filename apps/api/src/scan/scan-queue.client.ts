import type { OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createProducerConnection } from '@feedbouncer/jobs';
import { enqueueScan, SCAN_QUEUE } from '@feedbouncer/scan';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

/** How long closing may wait for Redis before the connection is dropped anyway. */
const CLOSE_WAIT_MS = 1_000;

/** Puts scan ids on the queue the worker consumes; the user token stays sealed in Postgres. */
export class ScanQueueClient implements OnModuleDestroy {
  readonly #redis: Redis;
  readonly #queue: Queue;

  constructor(o: { redisUrl: string; prefix: string; log: Logger }) {
    this.#redis = createProducerConnection(o.redisUrl);
    this.#redis.on('error', (err) => o.log.warn('scan.redis_error', errorFields(err)));
    this.#queue = new Queue(SCAN_QUEUE, { connection: this.#redis, prefix: o.prefix });
    this.#queue.on('error', (err) => o.log.warn('scan.queue_error', errorFields(err)));
  }

  async enqueue(scanId: string): Promise<void> {
    await enqueueScan(this.#queue, scanId);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([
      this.#queue.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS)),
    ]);
    this.#redis.disconnect();
  }
}
