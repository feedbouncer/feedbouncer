import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';

const LATENCY = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const WAIT = [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600, 21600];
const SCAN_DURATION = [5, 15, 30, 60, 120, 240, 600];
const SCAN_COMMENTS = [0, 20, 50, 100, 250, 500, 1000, 2000, 5000];

export interface FbMetrics {
  readonly registry: Registry;
  readonly jobs: Counter<'queue' | 'job_type' | 'outcome'>;
  readonly queueWait: Histogram<'queue'>;
  readonly connectorCalls: Counter<'platform' | 'operation' | 'outcome'>;
  readonly connectorCallDuration: Histogram<'platform' | 'operation'>;
  readonly webhookDeliveries: Counter<'platform' | 'outcome'>;
  readonly webhookEvents: Counter<'platform'>;
  readonly webhookEventDelay: Histogram<'platform'>;
  readonly commentIngestLag: Histogram<'platform' | 'outcome'>;
  readonly httpRequests: Counter<'method' | 'route' | 'status_class'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly collectErrors: Counter<'collector'>;
  readonly negativeLag: Counter<'source'>;
  readonly scanFinished: Counter<'status' | 'reason'>;
  readonly scanDuration: Histogram<never>;
  readonly scanCommentsScanned: Histogram<never>;
  readonly scanAuthorize: Counter<never>;
  readonly scanCreated: Counter<never>;
  readonly scanCtaClicks: Counter<never>;
  /**
   * Scrape-time preparation hooks. They run before collect_errors_total is read, so a
   * collector that fails during a scrape is counted in that same scrape.
   */
  readonly scrapeHooks: Array<() => Promise<void>>;
}

export function createMetrics(service: 'api' | 'worker'): FbMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  const r = [registry];
  const scrapeHooks: Array<() => Promise<void>> = [];
  return {
    scrapeHooks,
    registry,
    jobs: new Counter({
      name: 'feedbouncer_jobs_total',
      help: 'Job lifecycle events by outcome (enqueued, deduplicated, completed, retried, deferred, dead_lettered, replayed, duplicate_delivery, requeued).',
      labelNames: ['queue', 'job_type', 'outcome'] as const,
      registers: r,
    }),
    queueWait: new Histogram({
      name: 'feedbouncer_queue_wait_seconds',
      help: 'Time a job waited between becoming due and being claimed.',
      labelNames: ['queue'] as const,
      buckets: WAIT,
      registers: r,
    }),
    connectorCalls: new Counter({
      name: 'feedbouncer_connector_api_calls_total',
      help: 'Platform API calls by outcome (ok or connector error kind).',
      labelNames: ['platform', 'operation', 'outcome'] as const,
      registers: r,
    }),
    connectorCallDuration: new Histogram({
      name: 'feedbouncer_connector_api_call_duration_seconds',
      help: 'Platform API call latency, including the single token-refresh retry.',
      labelNames: ['platform', 'operation'] as const,
      buckets: LATENCY,
      registers: r,
    }),
    webhookDeliveries: new Counter({
      name: 'feedbouncer_webhook_deliveries_total',
      help: 'Webhook deliveries by outcome (accepted, duplicate, rejected).',
      labelNames: ['platform', 'outcome'] as const,
      registers: r,
    }),
    webhookEvents: new Counter({
      name: 'feedbouncer_webhook_events_total',
      help: 'Events in accepted (non-duplicate) webhook deliveries.',
      labelNames: ['platform'] as const,
      registers: r,
    }),
    webhookEventDelay: new Histogram({
      name: 'feedbouncer_webhook_event_delay_seconds',
      help: 'Platform event time to receipt; negative skew is clamped to 0.',
      labelNames: ['platform'] as const,
      buckets: WAIT,
      registers: r,
    }),
    commentIngestLag: new Histogram({
      name: 'feedbouncer_comment_ingest_lag_seconds',
      help: 'Platform event time to comment ingested, by ingest outcome; negative skew is clamped to 0.',
      labelNames: ['platform', 'outcome'] as const,
      buckets: WAIT,
      registers: r,
    }),
    httpRequests: new Counter({
      name: 'feedbouncer_http_requests_total',
      help: 'API requests by route pattern and status class.',
      labelNames: ['method', 'route', 'status_class'] as const,
      registers: r,
    }),
    httpDuration: new Histogram({
      name: 'feedbouncer_http_request_duration_seconds',
      help: 'API request duration by route pattern.',
      labelNames: ['method', 'route'] as const,
      buckets: LATENCY,
      registers: r,
    }),
    collectErrors: new Counter({
      name: 'feedbouncer_telemetry_collect_errors_total',
      help: 'Scrape-time collectors that failed (their gauges are omitted).',
      labelNames: ['collector'] as const,
      registers: r,
      async collect() {
        await Promise.all(scrapeHooks.map((h) => h().catch(() => undefined)));
      },
    }),
    negativeLag: new Counter({
      name: 'feedbouncer_telemetry_negative_lag_total',
      help: 'Lag samples clamped because the source timestamp was in the future.',
      labelNames: ['source'] as const,
      registers: r,
    }),
    scanFinished: new Counter({
      name: 'feedbouncer_scan_finished_total',
      help: 'Free scans finished, by status (completed, failed) and failure reason (none when completed).',
      labelNames: ['status', 'reason'] as const,
      registers: r,
    }),
    scanDuration: new Histogram({
      name: 'feedbouncer_scan_duration_seconds',
      help: 'Free scan run time, from claim to the stored result or failure.',
      buckets: SCAN_DURATION,
      registers: r,
    }),
    scanCommentsScanned: new Histogram({
      name: 'feedbouncer_scan_comments_scanned',
      help: 'Visible comments counted by a completed free scan.',
      buckets: SCAN_COMMENTS,
      registers: r,
    }),
    scanAuthorize: new Counter({
      name: 'feedbouncer_scan_authorize_total',
      help: 'Free scan visitors sent to the Facebook dialog.',
      registers: r,
    }),
    scanCreated: new Counter({
      name: 'feedbouncer_scan_created_total',
      help: 'Free scans queued.',
      registers: r,
    }),
    scanCtaClicks: new Counter({
      name: 'feedbouncer_scan_cta_clicks_total',
      help: 'Sign-up links followed from a free scan result.',
      registers: r,
    }),
  };
}
