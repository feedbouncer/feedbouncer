// Meta's signed webhook intake. These routes carry no session and no Origin:
// authenticity is the X-Hub-Signature-256 HMAC over the exact bytes received
// (verified by the connector framework's gate) and, for the subscription
// handshake, the shared verify token. Nothing here echoes request data except
// a challenge that matched a strict token pattern, as text/plain.
import type { FastifyError, FastifyInstance } from 'fastify';
import { routeWebhookDelivery } from '@feedbouncer/comments';
import { verifyHandshake } from '@feedbouncer/connector-facebook';
import { errorFields } from '@feedbouncer/service-runtime';
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

export async function registerFacebookWebhook(
  fastify: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
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
    scope.setErrorHandler((err: FastifyError, _req, reply) => {
      const status = err.statusCode !== undefined && err.statusCode < 500 ? err.statusCode : 500;
      if (status === 500) deps.log.error('webhook intake failed', errorFields(err));
      const e =
        status === 500
          ? new ApiError(500, 'internal_error')
          : new ApiError(
              status,
              'invalid_request',
              status === 413 ? 'Request body too large.' : undefined,
            );
      return reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
    });

    scope.route({
      method: 'GET',
      url: FACEBOOK_WEBHOOK_PATH,
      config: { publicWebhook: true },
      handler: async (req, reply) => {
        const r = verifyHandshake(req.query as Record<string, unknown>, fb.webhookVerifyToken);
        const res = reply.type('text/plain; charset=utf-8');
        if (!r.ok) return res.status(403).send('forbidden');
        return res.status(200).send(r.challenge);
      },
    });

    scope.route({
      method: 'POST',
      url: FACEBOOK_WEBHOOK_PATH,
      bodyLimit: WEBHOOK_BODY_LIMIT,
      config: { publicWebhook: true },
      handler: async (req, reply) => {
        const outcome = await connectors.stack.webhooks.handle(
          {
            platform: 'facebook',
            connectionId: null,
            headers: req.headers,
            rawBody: req.body as Buffer,
          },
          deliver,
        );
        // 200 for accepted and duplicate so Meta stops retrying; 403 for anything unverified.
        // A failing deliver() throws: the error handler answers 500 and the ledger lets Meta retry.
        const rejected = outcome.status === 'rejected';
        return reply
          .status(rejected ? 403 : 200)
          .type('text/plain; charset=utf-8')
          .send(rejected ? 'forbidden' : 'ok');
      },
    });
  });
}
