import { expect, it } from 'vitest';
import { createMetrics } from './metrics.js';
import {
  promConnectorObserver,
  promIngestObserver,
  promJobSink,
  promWebhookObserver,
} from './sinks.js';

it('maps job events, waits, connector calls and webhooks onto the registry', async () => {
  const m = createMetrics('worker');
  const j = promJobSink(m);
  j.onEvent('completed', 'youtube', 'scripted');
  j.onWait('youtube', 1500);
  promConnectorObserver(m).onCall({
    platform: 'youtube',
    operation: 'list_comments',
    outcome: 'ok',
    durationMs: 120,
  });
  const w = promWebhookObserver(m);
  w.onDelivery({
    platform: 'facebook',
    outcome: 'accepted',
    eventCount: 2,
    eventDelaysMs: [1000, 0],
    negativeSkews: 1,
  });
  w.onDelivery({
    platform: 'facebook',
    outcome: 'duplicate',
    eventCount: 0,
    eventDelaysMs: [],
    negativeSkews: 0,
  });
  const t = await m.registry.metrics();
  expect(t).toMatch(
    /feedbouncer_jobs_total\{[^}]*queue="platform-youtube"[^}]*job_type="scripted"[^}]*outcome="completed"[^}]*\} 1/,
  );
  expect(t).toMatch(/feedbouncer_queue_wait_seconds_count\{[^}]*queue="platform-youtube"[^}]*\} 1/);
  expect(t).toMatch(/feedbouncer_connector_api_calls_total\{[^}]*outcome="ok"[^}]*\} 1/);
  expect(t).toMatch(/feedbouncer_webhook_events_total\{[^}]*platform="facebook"[^}]*\} 2/);
  expect(t).toMatch(/feedbouncer_webhook_deliveries_total\{[^}]*outcome="duplicate"[^}]*\} 1/);
  expect(t).toMatch(
    /feedbouncer_telemetry_negative_lag_total\{[^}]*source="webhook_event"[^}]*\} 1/,
  );
});

it('records comment ingest lag in seconds by platform and outcome', async () => {
  const m = createMetrics('worker');
  const o = promIngestObserver(m);
  o.onIngested({ platform: 'facebook', lagMs: 2500, outcome: 'created' });
  o.onIngested({ platform: 'facebook', lagMs: 0, outcome: 'stale' });
  const t = await m.registry.metrics();
  expect(t).toMatch(
    /feedbouncer_comment_ingest_lag_seconds_count\{[^}]*platform="facebook"[^}]*outcome="created"[^}]*\} 1/,
  );
  expect(t).toMatch(
    /feedbouncer_comment_ingest_lag_seconds_sum\{[^}]*outcome="created"[^}]*\} 2\.5/,
  );
  expect(t).toMatch(/feedbouncer_comment_ingest_lag_seconds_count\{[^}]*outcome="stale"[^}]*\} 1/);
});
