import type { FastifyInstance } from 'fastify';
import { withLogContext, type Logger } from '@feedbouncer/service-runtime';
import type { FbMetrics } from '@feedbouncer/observability';
import type { TracedRequest } from './traced-request.js';

// One line per request: method, route PATTERN, status, duration, request id.
// Never request.url: paths and query strings can carry tokens and emails.
// Metrics use the same route pattern, so their label set is bounded by the
// route table ('unmatched' for everything the router did not match).
export function registerRequestLog(
  fastify: FastifyInstance,
  log: Logger,
  metrics: FbMetrics,
): void {
  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const { fbTrace: trace, org } = request as TracedRequest;
    // The log context drops values that are not safe ids, so a hostile id never
    // reaches the line as request_id.
    withLogContext(
      { request_id: String(request.id), ...(org ? { tenant_id: org.organizationId } : {}) },
      () =>
        log.info('request', {
          method: request.method,
          route,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
          requestId: request.id,
          ...(trace ? { trace_id: trace.trace_id, span_id: trace.span_id } : {}),
        }),
    );
    try {
      const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
      metrics.httpRequests.inc({ method: request.method, route, status_class: statusClass });
      metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    } catch {
      // Telemetry never fails a response.
    }
  });
}
