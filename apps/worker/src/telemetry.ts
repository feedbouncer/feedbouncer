import type { createPool } from '@feedbouncer/db';
import {
  PgSyncRecorder,
  type ConnectorCallObserver,
  type SyncRecorder,
} from '@feedbouncer/connectors';
import type { JobEventSink, PgJobLedger } from '@feedbouncer/jobs';
import {
  PgHealthReader,
  createMetrics,
  initTracing,
  promConnectorObserver,
  promJobSink,
  registerConnectorHealthMetrics,
  registerQueueMetrics,
  type FbMetrics,
  type TracingHandle,
} from '@feedbouncer/observability';
import type { Logger } from '@feedbouncer/service-runtime';
import type { WorkerEnv } from './env.js';

export interface WorkerTelemetry {
  readonly tracing: TracingHandle;
  readonly metrics: FbMetrics;
  readonly jobSink: JobEventSink;
  readonly connectorObserver: ConnectorCallObserver;
  readonly sync: SyncRecorder;
}

/**
 * Builds the worker's telemetry. Call before any span-producing code runs: it
 * registers the global tracer provider and context manager.
 */
export function buildWorkerTelemetry(d: {
  env: WorkerEnv;
  pool: ReturnType<typeof createPool>;
  ledger: PgJobLedger;
  log: Logger;
}): WorkerTelemetry {
  const tracing = initTracing(d.env.telemetry, d.log);
  const metrics = createMetrics('worker');
  registerConnectorHealthMetrics(metrics, new PgHealthReader(d.pool, d.env.health), {
    maxSeries: d.env.telemetry.metrics.maxConnections,
    log: d.log,
  });
  registerQueueMetrics(metrics, () => d.ledger.queueStats(), { log: d.log });
  return {
    tracing,
    metrics,
    jobSink: promJobSink(metrics),
    connectorObserver: promConnectorObserver(metrics),
    sync: new PgSyncRecorder(d.pool),
  };
}
