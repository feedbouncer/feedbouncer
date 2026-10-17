// Public one-click alert unsubscribe (see http/one-click-route.ts). Like the other recipient
// routes, it skips the Origin check.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { registerOneClickRoute } from '../http/one-click-route.js';
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

export function registerUnsubscribeRoute(
  fastify: FastifyInstance,
  deps: AppDeps,
  alerts: AlertsService,
): Promise<void> {
  return registerOneClickRoute(fastify, deps, {
    url: UNSUBSCRIBE_PATH,
    failure: 'alert unsubscribe failed',
    handler: async (req) => {
      await alerts.limitPublic(req.ip);
      return alerts.unsubscribe(unsubscribeToken(req));
    },
  });
}
