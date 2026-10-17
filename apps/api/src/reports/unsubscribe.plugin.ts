// Public one-click report unsubscribe (see http/one-click-route.ts). Every token, valid or not,
// gets 200 { status }: 'invalid', 'already' or 'unsubscribed', and nothing else about the
// subscription. Tokens are 256-bit random and the route is rate-limited per IP, so a valid token
// cannot be found by guessing.
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { registerOneClickRoute } from '../http/one-click-route.js';
import { ReportsService } from './reports.service.js';

/** An empty body (the web page) or exactly the RFC 8058 one-click form body. */
function checkBody(body: unknown): void {
  if (body === undefined || body === null) return;
  const keys = typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  const oneClick =
    keys?.length === 1 && (body as Record<string, unknown>)['List-Unsubscribe'] === 'One-Click';
  if (keys?.length !== 0 && !oneClick) throw new ApiError(400, 'invalid_request');
}

export function registerReportUnsubscribeRoute(
  fastify: FastifyInstance,
  deps: AppDeps,
  reports: ReportsService,
): Promise<void> {
  return registerOneClickRoute(fastify, deps, {
    url: '/api/v1/report-subscriptions/unsubscribe',
    failure: 'report unsubscribe failed',
    handler: (req) => {
      checkBody(req.body);
      const token = (req.query as Record<string, unknown>).token;
      return reports.unsubscribe(req.ip, typeof token === 'string' ? token : '');
    },
  });
}
