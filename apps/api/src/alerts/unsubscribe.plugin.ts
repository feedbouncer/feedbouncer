// Public one-click unsubscribe, registered as an encapsulated Fastify scope so the
// RFC 8058 form parser (`List-Unsubscribe=One-Click`) exists for this route only:
// every other route keeps JSON as its single body type. The route is
// token-authenticated and, like the other recipient routes, skips the Origin check.
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { errorFields } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { ApiError, errorBody } from '../http/errors.js';
import { parseBody } from '../http/validation.js';
import { AlertsService } from './alerts.service.js';
import { TOKEN_RE, TokenBody } from './dto.js';

export const UNSUBSCRIBE_PATH = '/api/v1/alert-recipients/unsubscribe';

/** The token of an unsubscribe request: the JSON body, or `?token=` with a one-click form body. */
export function unsubscribeToken(req: FastifyRequest): string {
  const body = req.body as Record<string, unknown> | undefined | null;
  const query = (req.query as Record<string, unknown> | undefined)?.token;
  if (body && Object.hasOwn(body, 'List-Unsubscribe')) {
    // RFC 8058: the one-click body is exactly `List-Unsubscribe=One-Click`.
    if (body['List-Unsubscribe'] !== 'One-Click') throw new ApiError(400, 'invalid_request');
  } else if (body && Object.keys(body).length > 0) {
    return parseBody(TokenBody, body).token;
  }
  if (query === undefined) throw new ApiError(400, 'invalid_request');
  if (typeof query !== 'string' || !TOKEN_RE.test(query)) throw new ApiError(404, 'invalid_token');
  return query;
}

export async function registerUnsubscribeRoute(
  fastify: FastifyInstance,
  deps: AppDeps,
  alerts: AlertsService,
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
        deps.log.error('alert unsubscribe failed', errorFields(err));
        e = new ApiError(500, 'internal_error');
      }
      return reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
    });
    scope.route({
      method: 'POST',
      url: UNSUBSCRIBE_PATH,
      config: { publicWebhook: true },
      handler: async (req, reply) => {
        await alerts.limitPublic(req.ip);
        const r = await alerts.unsubscribe(unsubscribeToken(req));
        return reply.status(200).send(r);
      },
    });
  });
}
