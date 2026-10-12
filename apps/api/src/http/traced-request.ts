import type { FastifyRequest } from 'fastify';

/** The request as seen by telemetry: org is set by the org guard, fbTrace by the trace interceptor. */
export type TracedRequest = FastifyRequest & {
  org?: { organizationId: string };
  fbTrace?: { trace_id: string; span_id: string } | undefined;
};
