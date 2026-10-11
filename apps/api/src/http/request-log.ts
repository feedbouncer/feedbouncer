import type { FastifyInstance } from 'fastify';
import type { Logger } from '@feedbouncer/service-runtime';

// One line per request: method, route PATTERN, status, duration, request id.
// Never request.url: paths and query strings can carry tokens and emails.
export function registerRequestLog(fastify: FastifyInstance, log: Logger): void {
  fastify.addHook('onResponse', async (request, reply) => {
    log.info('request', {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      requestId: request.id,
    });
  });
}
