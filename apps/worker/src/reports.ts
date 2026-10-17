import type { createPool } from '@feedbouncer/db';
import type { Mailer } from '@feedbouncer/mailer';
import {
  DISPATCH_EVERY_MS,
  PgReportSubscriptions,
  SCHEDULER_EVERY_MS,
  WeeklyReportDispatcher,
  WeeklyReportScheduler,
} from '@feedbouncer/reports';
import type { KeyProvider } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { every } from './interval.js';

export interface ReportLoopsDeps {
  readonly pool: ReturnType<typeof createPool>;
  readonly log: Logger;
  /** Both are loaded whenever WEEKLY_REPORTS=on (see env.ts). */
  readonly mailer: Mailer | null;
  readonly web: URL | null;
  readonly keys: KeyProvider;
}

export function startReportLoops(
  config: { readonly enabled: boolean },
  deps: ReportLoopsDeps,
): { stop(): void } | null {
  const { pool, log, mailer, web } = deps;
  if (!config.enabled) {
    log.info('reports.disabled');
    return null;
  }
  if (!mailer || !web) throw new Error('weekly reports need a mailer and PUBLIC_WEB_URL');
  const scheduler = new WeeklyReportScheduler({ pool, log });
  const dispatcher = new WeeklyReportDispatcher({
    pool,
    log,
    mailer,
    web,
    subscriptions: new PgReportSubscriptions(pool, deps.keys),
  });
  const failed = 'reports.tick_failed';
  const timers = [
    every('scheduler', SCHEDULER_EVERY_MS, () => scheduler.tick(), log, failed),
    every('dispatch', DISPATCH_EVERY_MS, () => dispatcher.tick(), log, failed),
  ];
  return { stop: () => timers.forEach(clearInterval) };
}
