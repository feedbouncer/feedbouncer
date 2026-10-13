// Meta's signed webhook intake (Facebook Pages, and Instagram through Facebook
// Login). These routes carry no session and no Origin: authenticity is the
// X-Hub-Signature-256 HMAC over the exact bytes received (verified by the
// connector framework's gate) and, for the subscription handshake, the shared
// verify token. Nothing here echoes request data except a challenge that
// matched a strict token pattern, as text/plain.
import type { FastifyError, FastifyInstance } from 'fastify';
import { routeWebhookDelivery } from '@feedbouncer/comments';
import { verifyHandshake } from '@feedbouncer/connector-facebook';
import type { Platform } from '@feedbouncer/connectors';
import { errorFields, type Secret } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { ApiError, errorBody } from '../http/errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route that authenticates by platform signature and so skips the Origin check. */
    publicWebhook?: boolean;
  }
}

/** Webhook bodies may exceed the API's global 64 KiB limit; the gate also caps at 1 MiB. */
export const WEBHOOK_BODY_LIMIT = 1_048_576;
export const FACEBOOK_WEBHOOK_PATH = '/api/v1/webhooks/facebook';
export const INSTAGRAM_WEBHOOK_PATH = '/api/v1/webhooks/instagram';

interface MetaWebhookRoute {
  platform: Platform;
  path: string;
  verifyToken: Secret;
  connectors: NonNullable<AppDeps['connectors']>;
  deliver: ReturnType<typeof routeWebhookDelivery>;
}

/** The handshake (GET) and delivery (POST) routes of one platform, inside the raw-body scope. */
export function registerMetaWebhook(scope: FastifyInstance, r: MetaWebhookRoute): void {
  scope.route({
    method: 'GET',
    url: r.path,
    config: { publicWebhook: true },
    handler: async (req, reply) => {
      const h = verifyHandshake(req.query as Record<string, unknown>, r.verifyToken);
      const res = reply.type('text/plain; charset=utf-8');
      if (!h.ok) return res.status(403).send('forbidden');
      return res.status(200).send(h.challenge);
    },
  });

  scope.route({
    method: 'POST',
    url: r.path,
    bodyLimit: WEBHOOK_BODY_LIMIT,
    config: { publicWebhook: true },
    handler: async (req, reply) => {
      // deliver() only enqueues; ingest runs in the worker, so nothing here waits on Graph.
      const outcome = await r.connectors.stack.webhooks.handle(
        {
          platform: r.platform,
          connectionId: null,
          headers: req.headers,
          rawBody: req.body as Buffer,
        },
        r.deliver,
      );
      // 200 for accepted and duplicate so Meta stops retrying; 403 for anything unverified.
      // A failing deliver() throws: the error handler answers 503 and the ledger lets Meta retry.
      const rejected = outcome.status === 'rejected';
      return reply
        .status(rejected ? 403 : 200)
        .type('text/plain; charset=utf-8')
        .send(rejected ? 'forbidden' : 'ok');
    },
  });
}

export async function registerMetaWebhooks(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  const fb = deps.env.facebook;
  const connectors = deps.connectors;
  const producer = deps.producer;
  // Without the connector configured the routes do not exist.
  if (!fb || !connectors || !producer) return;
  const deliver = routeWebhookDelivery({
    directory: connectors.stack.directory,
    producer,
    log: deps.log,
  });

  await fastify.register(async (scope) => {
    // Encapsulated: only these routes see raw bytes, so the HMAC runs over what Meta signed.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );

    // These routes bypass Nest's exception filter, so map errors here: the
    // envelope never carries error text (it can quote infrastructure details).
    // A server-side failure (in practice: the job queue is unreachable) is a
    // 503, so Meta redelivers instead of the event being dropped.
    scope.setErrorHandler((err: FastifyError, _req, reply) => {
      const status = err.statusCode !== undefined && err.statusCode < 500 ? err.statusCode : 503;
      if (status === 503) deps.log.error('webhook intake failed', errorFields(err));
      const e =
        status === 503
          ? new ApiError(503, 'service_unavailable')
          : new ApiError(
              status,
              'invalid_request',
              status === 413 ? 'Request body too large.' : undefined,
            );
      return reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
    });

    // Both platforms are subscribed on the same Meta app, so they share its verify token.
    const common = { verifyToken: fb.webhookVerifyToken, connectors, deliver };
    registerMetaWebhook(scope, { ...common, platform: 'facebook', path: FACEBOOK_WEBHOOK_PATH });
    if (deps.env.instagram)
      registerMetaWebhook(scope, {
        ...common,
        platform: 'instagram',
        path: INSTAGRAM_WEBHOOK_PATH,
      });
  });
}
