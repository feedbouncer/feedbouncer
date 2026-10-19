import { Counter, Histogram, type Registry } from '@prometheus-io/client';

export type MetricsRegistry = Registry;

export interface WebhookMetrics {
  attempt(outcome: 'succeeded' | 'retrying' | 'failed' | 'cancelled'): void;
  /** Seconds from the event to its successful delivery. */
  lag(seconds: number): void;
  disabled(): void;
}

const LAG = [1, 5, 15, 60, 300, 900, 3600, 21600, 86400];

export function createWebhookMetrics(registry: MetricsRegistry): WebhookMetrics {
  const registers = [registry];
  const attempts = new Counter({
    name: 'feedbouncer_webhook_delivery_attempts_total',
    help: 'Outgoing webhook delivery attempts by outcome (succeeded, retrying, failed, cancelled).',
    labelNames: ['outcome'] as const,
    registers,
  });
  const lag = new Histogram({
    name: 'feedbouncer_webhook_delivery_lag_seconds',
    help: 'Time from an event to its successful outgoing webhook delivery.',
    buckets: LAG,
    registers,
  });
  const disabled = new Counter({
    name: 'feedbouncer_webhook_endpoints_disabled_total',
    help: 'Webhook endpoints disabled automatically after repeated failures.',
    registers,
  });
  return {
    attempt: (outcome) => attempts.inc({ outcome }),
    lag: (seconds) => lag.observe(Math.max(0, seconds)),
    disabled: () => disabled.inc(),
  };
}
