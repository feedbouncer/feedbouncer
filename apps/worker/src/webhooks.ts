import { lookup } from 'node:dns/promises';
import type { createPool } from '@feedbouncer/db';
import type { Mailer } from '@feedbouncer/mailer';
import type { KeyProvider } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import {
  PgWebhookEndpoints,
  WebhookDispatcher,
  createGuardedTransport,
  createWebhookMetrics,
  type MetricsRegistry,
} from '@feedbouncer/webhooks';
import { every } from './interval.js';

const DISPATCH_INTERVAL_MS = 1_000;
const REAP_INTERVAL_MS = 30_000;
const PURGE_INTERVAL_MS = 3_600_000;

export interface WebhookLoopsConfig {
  readonly concurrency: number;
  readonly allowedPrivateCidrs: readonly string[];
}

export interface WebhookLoopsDeps {
  readonly pool: ReturnType<typeof createPool>;
  readonly log: Logger;
  readonly keys: KeyProvider;
  readonly mailer: Mailer | null;
  readonly registry: MetricsRegistry;
}

export function startWebhookLoops(
  config: WebhookLoopsConfig,
  { pool, log, keys, mailer, registry }: WebhookLoopsDeps,
): { stop(): Promise<void> } {
  const dispatcher = new WebhookDispatcher({
    pool,
    endpoints: new PgWebhookEndpoints(pool, keys, {
      resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
      allowedPrivateCidrs: config.allowedPrivateCidrs,
    }),
    transport: createGuardedTransport({ allowedPrivateCidrs: config.allowedPrivateCidrs }),
    mailer,
    log,
    metrics: createWebhookMetrics(registry),
    concurrency: config.concurrency,
  });
  const failed = 'webhooks.tick_failed';
  const timers = [
    every('dispatch', DISPATCH_INTERVAL_MS, () => dispatcher.tick(), log, failed),
    every('reap', REAP_INTERVAL_MS, () => dispatcher.reap(), log, failed),
    every('purge', PURGE_INTERVAL_MS, () => dispatcher.purge(), log, failed),
  ];
  return {
    stop: async () => {
      timers.forEach(clearInterval);
      await dispatcher.drain();
    },
  };
}
