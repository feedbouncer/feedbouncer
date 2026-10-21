import type { createPool } from '@feedbouncer/db';
import { runPurge, type RetentionSettings } from '@feedbouncer/privacy';
import type { Logger } from '@feedbouncer/service-runtime';
import { every } from './interval.js';

export interface RetentionLoopDeps {
  readonly pool: ReturnType<typeof createPool>;
  readonly settings: RetentionSettings;
  readonly log: Logger;
  /** PRIVACY_EXPORT_DIR: expired subject exports are deleted from here on every run. */
  readonly exportDir: string;
}

/** Runs the retention purge every purgeIntervalMinutes; replicas take turns via its lock. */
export function startRetentionLoop({ pool, settings, log, exportDir }: RetentionLoopDeps): {
  stop(): void;
} {
  const timer = every(
    'retention',
    settings.purgeIntervalMinutes * 60_000,
    () => runPurge(pool, settings, { log, exportDir }),
    log,
    'retention.purge_failed',
  );
  return { stop: () => clearInterval(timer) };
}
