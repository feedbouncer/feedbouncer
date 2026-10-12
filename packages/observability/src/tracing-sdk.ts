import { context, diag, DiagLogLevel, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { TelemetryConfig } from './config.js';
import { diagToLogger } from './diag.js';

export interface TracingHandle {
  readonly exporting: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const bounded = async (
  p: Promise<unknown>,
  ms: number,
  log: Logger,
  what: string,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), ms);
    timer.unref();
  });
  try {
    const r = await Promise.race([p.then(() => 'ok' as const), timeout]);
    if (r === 'timeout') log.warn('telemetry.shutdown_timeout', { what, ms });
  } catch (err) {
    log.warn('telemetry.shutdown_failed', { what, ...errorFields(err) });
  } finally {
    clearTimeout(timer);
  }
};

export function initTracing(
  cfg: TelemetryConfig,
  log: Logger,
  extra: { spanProcessors?: SpanProcessor[] } = {},
): TracingHandle {
  diag.setLogger(diagToLogger(log), DiagLogLevel.WARN);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const exporting = cfg.traces.exporter === 'otlp';
  const processors: SpanProcessor[] = [...(extra.spanProcessors ?? [])];
  if (exporting) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ timeoutMillis: Math.min(10_000, cfg.shutdownTimeoutMs) }),
        { exportTimeoutMillis: Math.min(10_000, cfg.shutdownTimeoutMs) },
      ),
    );
  }
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': cfg.traces.serviceName }),
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: processors,
  });
  trace.setGlobalTracerProvider(provider);
  log.info('telemetry.tracing_ready', { exporting });
  return {
    exporting,
    forceFlush: () => bounded(provider.forceFlush(), cfg.shutdownTimeoutMs, log, 'flush'),
    shutdown: () => bounded(provider.shutdown(), cfg.shutdownTimeoutMs, log, 'tracing'),
  };
}
