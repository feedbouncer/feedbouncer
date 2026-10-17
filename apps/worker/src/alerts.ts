import {
  AlertDispatcher,
  FlagSweeper,
  PgAlertChannels,
  SpikeSweeper,
  slackHttp,
} from '@feedbouncer/alerts';
import type { SafeHttp } from '@feedbouncer/connectors';
import type { createPool } from '@feedbouncer/db';
import type { Mailer } from '@feedbouncer/mailer';
import type { KeyProvider } from '@feedbouncer/secrets';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { WorkerAlertsConfig } from './env.js';

const SWEEP_INTERVAL_MS = 60_000;
const DISPATCH_INTERVAL_MS = 5_000;

export interface AlertLoopsConfig {
  readonly alerts: WorkerAlertsConfig;
  /** Origin of the web app for links in alerts; only read when alerts are enabled. */
  readonly web: () => URL;
}

export interface AlertLoopsDeps {
  readonly pool: ReturnType<typeof createPool>;
  readonly log: Logger;
  readonly keys: KeyProvider;
  readonly mailer: Mailer | null;
  readonly slackHttp?: SafeHttp;
}

export function startAlertLoops(
  config: AlertLoopsConfig,
  deps: AlertLoopsDeps,
): { stop(): void } | null {
  const { alerts } = config;
  const { pool, log } = deps;
  if (!alerts.slack && !alerts.email) {
    log.info('alerts.disabled');
    return null;
  }
  const spike = new SpikeSweeper({ pool, log, capPerHour: alerts.capPerHour });
  const flags = new FlagSweeper({ pool, log, capPerHour: alerts.capPerHour });
  const dispatcher = new AlertDispatcher({
    pool,
    log,
    channels: new PgAlertChannels(pool, deps.keys),
    web: config.web(),
    enabled: alerts,
    mailer: deps.mailer,
    slackHttp: deps.slackHttp ?? slackHttp(),
    emailPerMinute: alerts.emailPerMinute,
  });
  const timers = [
    every('spike', SWEEP_INTERVAL_MS, () => spike.tick(), log),
    every('flags', SWEEP_INTERVAL_MS, () => flags.tick(), log),
    every('dispatch', DISPATCH_INTERVAL_MS, () => dispatcher.tick(), log),
  ];
  return { stop: () => timers.forEach(clearInterval) };
}

function every(
  loop: string,
  intervalMs: number,
  tick: () => Promise<unknown>,
  log: Logger,
): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err: unknown) => log.error('alerts.tick_failed', { loop, ...errorFields(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}
