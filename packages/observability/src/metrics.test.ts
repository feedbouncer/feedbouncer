import { expect, it } from 'vitest';
import { createMetrics } from './metrics.js';

it('exposes the documented metric names with bounded labels', async () => {
  const m = createMetrics('worker');
  m.jobs.inc({ queue: 'platform-youtube', job_type: 'scripted', outcome: 'completed' });
  m.queueWait.observe({ queue: 'platform-youtube' }, 1.5);
  m.connectorCalls.inc({ platform: 'youtube', operation: 'list_comments', outcome: 'ok' });
  const text = await m.registry.metrics();
  for (const name of [
    'feedbouncer_jobs_total',
    'feedbouncer_queue_wait_seconds',
    'feedbouncer_connector_api_calls_total',
    'feedbouncer_connector_api_call_duration_seconds',
    'feedbouncer_webhook_deliveries_total',
    'feedbouncer_webhook_events_total',
    'feedbouncer_webhook_event_delay_seconds',
    'feedbouncer_comment_ingest_lag_seconds',
    'feedbouncer_http_requests_total',
    'feedbouncer_http_request_duration_seconds',
    'feedbouncer_telemetry_collect_errors_total',
    'feedbouncer_telemetry_negative_lag_total',
  ])
    expect(text).toContain(`# HELP ${name} `);
  expect(text).toContain('service="worker"');
  expect(text).not.toMatch(/tenant|organization|ledger|comment_id|job_id/);
});

it('two instances do not share a registry', () => {
  expect(createMetrics('api').registry).not.toBe(createMetrics('api').registry);
});
