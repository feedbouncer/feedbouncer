import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ApiError, ApiErrorFilter, errorBody } from './http/errors.js';
import { isTrustedOrigin } from './http/origin.guard.js';
import { registerRequestLog } from './http/request-log.js';
import { TraceInterceptor } from './http/trace.interceptor.js';
import { trustProxyHops } from './http/trust-proxy.js';
import type { AppDeps } from './deps.js';
import { registerUnsubscribeRoute } from './alerts/unsubscribe.plugin.js';
import { registerMetaWebhooks } from './webhooks/meta-webhooks.plugin.js';

export async function buildApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // No Fastify logger, so no built-in request logging: registerRequestLog
    // writes the only (redacted) request line.
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: trustProxyHops(deps.env.trustProxyHops),
    routerOptions: { ignoreTrailingSlash: false },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), adapter, {
    logger: false,
    // Throw instead of exiting the process on bootstrap errors.
    abortOnError: false,
    // Keep Fastify's own parsers only (JSON, and text/plain which is removed
    // below). Nest would add application/x-www-form-urlencoded, which a
    // cross-site HTML form can send without a CORS preflight.
    bodyParser: false,
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser('text/plain');

  const webOrigin = deps.env.publicWebUrl.origin;
  fastify.addHook('onRequest', async (req, reply) => {
    // Every request, not a path prefix: Fastify decodes paths ("/%61pi" is
    // "/api"), so matching the raw URL would be bypassable. Safe methods pass.
    // Routing runs before onRequest, so routeOptions.config is the matched
    // route's own. Only signature-verified webhook routes and the token-authenticated
    // alert recipient routes opt out of the check.
    if (req.routeOptions.config?.publicWebhook === true) return;
    if (!isTrustedOrigin(req.method, req.headers, webOrigin)) {
      const e = new ApiError(403, 'invalid_origin');
      return reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
    }
  });
  fastify.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
  });
  await registerMetaWebhooks(fastify, deps);
  await registerUnsubscribeRoute(fastify, deps);
  registerRequestLog(fastify, deps.log, deps.metrics);
  app.useGlobalInterceptors(new TraceInterceptor());
  app.useGlobalFilters(new ApiErrorFilter(deps.log));
  await app.init();
  return app;
}
