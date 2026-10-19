import type { createPool } from '@feedbouncer/db';
import { purgeExpiredIdempotency } from '@feedbouncer/public-api';
import type { Logger } from '@feedbouncer/service-runtime';
import { every } from './interval.js';

const PURGE_INTERVAL_MS = 3_600_000;

export interface IdempotencyPurgeDeps {
  readonly pool: ReturnType<typeof createPool>;
  readonly log: Logger;
}

export function startIdempotencyPurge({ pool, log }: IdempotencyPurgeDeps): { stop(): void } {
  const timer = every(
    'idempotency-purge',
    PURGE_INTERVAL_MS,
    async () => {
      const purged = await purgeExpiredIdempotency(pool);
      if (purged > 0) log.info('idempotency.purged', { purged });
    },
    log,
    'idempotency.purge_failed',
  );
  return { stop: () => clearInterval(timer) };
}
