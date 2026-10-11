import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Mailer } from '@feedbouncer/mailer';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ApiEnv } from './env.js';

/** Process-level resources, created in main.ts (or the test harness) and owned there. */
export interface AppDeps {
  readonly env: ApiEnv;
  readonly pool: pg.Pool;
  readonly redis: Redis;
  readonly mailer: Mailer;
  readonly log: Logger;
  /** Prepended to every Redis key the API writes, so tests can isolate and clean up. */
  readonly redisKeyPrefix: string;
}
