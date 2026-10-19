import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, RETRY_DELAYS_SECONDS } from './constants.js';
import { nextAttemptDelaySeconds } from './dispatcher.js';
import { createWebhookMetrics } from './metrics.js';

describe('nextAttemptDelaySeconds', () => {
  it('follows the retry schedule with ±10% jitter, rounded', () => {
    RETRY_DELAYS_SECONDS.forEach((base, i) => {
      expect(nextAttemptDelaySeconds(i + 1, () => 0.5)).toBe(base);
      expect(nextAttemptDelaySeconds(i + 1, () => 0)).toBe(Math.round(base * 0.9));
      expect(nextAttemptDelaySeconds(i + 1, () => 1)).toBe(Math.round(base * 1.1));
    });
    expect(nextAttemptDelaySeconds(1, () => 0.25)).toBe(57);
  });

  it('stops after the last attempt', () => {
    expect(nextAttemptDelaySeconds(MAX_ATTEMPTS, () => 0.5)).toBeNull();
    expect(nextAttemptDelaySeconds(MAX_ATTEMPTS + 1, () => 0.5)).toBeNull();
  });
});

describe('createWebhookMetrics', () => {
  it('registers the documented series', async () => {
    const registry = new Registry();
    const m = createWebhookMetrics(registry);
    m.attempt('succeeded');
    m.attempt('retrying');
    m.lag(2.5);
    m.disabled();
    const text = await registry.metrics();
    expect(text).toContain('feedbouncer_webhook_delivery_attempts_total{outcome="succeeded"} 1');
    expect(text).toContain('feedbouncer_webhook_delivery_attempts_total{outcome="retrying"} 1');
    expect(text).toContain('feedbouncer_webhook_delivery_lag_seconds_count 1');
    expect(text).toContain('feedbouncer_webhook_endpoints_disabled_total 1');
  });
});
