// A public one-click POST route (RFC 8058), registered as an encapsulated Fastify scope so the
// `List-Unsubscribe=One-Click` form parser exists for this route only: every other route keeps
// JSON as its single body type. The route is token-authenticated and skips the Origin check.
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { errorFields } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { ApiError, errorBody } from './errors.js';

export async function registerOneClickRoute(
  fastify: FastifyInstance,
  deps: AppDeps,
  route: { url: string; failure: string; handler: (req: FastifyRequest) => Promise<unknown> },
): Promise<void> {
  await fastify.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    // Outside Nest's exception filter: map errors here, never echoing error text.
    scope.setErrorHandler((err: FastifyError | ApiError, _req, reply) => {
      let e: ApiError;
      if (err instanceof ApiError) e = err;
      else if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
        e = new ApiError(err.statusCode === 415 ? 415 : 400, 'invalid_request');
      } else {
        deps.log.error(route.failure, errorFields(err));
        e = new ApiError(500, 'internal_error');
      }
      return reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
    });
    scope.route({
      method: 'POST',
      url: route.url,
      config: { publicWebhook: true },
      handler: async (req, reply) => reply.status(200).send(await route.handler(req)),
    });
  });
}
