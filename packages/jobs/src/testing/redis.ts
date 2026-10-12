import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';

export interface TestRedis {
  readonly connection: Redis;
  readonly prefix: string;
  readonly url: string;
  cleanup(): Promise<void>;
}

/** One connection and one unique key prefix per test run; cleanup deletes only that prefix. */
export function testRedis(): TestRedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL must be set for jobs integration tests.');
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  connection.on('error', () => {});
  const prefix = `fbt-${randomBytes(6).toString('hex')}`;
  return {
    connection,
    prefix,
    url,
    async cleanup() {
      const keys = await connection.keys(`${prefix}:*`).catch(() => [] as string[]);
      if (keys.length) await connection.del(...keys).catch(() => 0);
      connection.disconnect();
    },
  };
}
