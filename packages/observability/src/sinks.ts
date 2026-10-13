// Prometheus adapters for the observer and sink interfaces the connector and
// job layers expose. Those packages cannot import this one, so the wiring
// lives here and each adapter is handed to them by the process entry point.
import type { ConnectorCallObserver, WebhookObserver } from '@feedbouncer/connectors';
import { queueName, type JobEventSink } from '@feedbouncer/jobs';
import type { FbMetrics } from './metrics.js';

/**
 * Structural twin of the comment ingest job's observer. It is declared here
 * because the comments package cannot be imported from this one.
 */
export interface IngestObserver {
  onIngested(e: { platform: string; lagMs: number; outcome: string }): void;
}

export function promJobSink(m: FbMetrics): JobEventSink {
  return {
    onEvent: (event, platform, jobType) =>
      m.jobs.inc({ queue: queueName(platform), job_type: jobType, outcome: event }),
    onWait: (platform, waitMs) =>
      m.queueWait.observe({ queue: queueName(platform) }, waitMs / 1000),
  };
}

export function promConnectorObserver(m: FbMetrics): ConnectorCallObserver {
  return {
    onCall: (e) => {
      m.connectorCalls.inc({ platform: e.platform, operation: e.operation, outcome: e.outcome });
      m.connectorCallDuration.observe(
        { platform: e.platform, operation: e.operation },
        e.durationMs / 1000,
      );
    },
  };
}

export function promWebhookObserver(m: FbMetrics): WebhookObserver {
  return {
    onDelivery: (e) => {
      m.webhookDeliveries.inc({ platform: e.platform, outcome: e.outcome });
      if (e.outcome !== 'accepted') return;
      m.webhookEvents.inc({ platform: e.platform }, e.eventCount);
      for (const ms of e.eventDelaysMs) {
        m.webhookEventDelay.observe({ platform: e.platform }, ms / 1000);
      }
      if (e.negativeSkews > 0) m.negativeLag.inc({ source: 'webhook_event' }, e.negativeSkews);
    },
  };
}

export function promIngestObserver(m: FbMetrics): IngestObserver {
  return {
    onIngested: (e) =>
      m.commentIngestLag.observe({ platform: e.platform, outcome: e.outcome }, e.lagMs / 1000),
  };
}
