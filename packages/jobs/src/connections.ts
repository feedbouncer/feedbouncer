import { Redis } from 'ioredis';

// BullMQ workers block on Redis and need commands to wait out an outage, so
// their connection must not cap retries. Producers sit on request paths and
// must fail an enqueue instead of hanging, so theirs fails fast. Use separate
// connections for the two, as BullMQ recommends.

/** For `Worker`: `maxRetriesPerRequest: null`, as BullMQ requires. */
export function createWorkerConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** For `QueueSet`: commands fail after one reconnect attempt and when offline. */
export function createProducerConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
}
