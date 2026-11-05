import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  scopeAllows,
  type ApiKeyContext,
  type ApiKeyScope,
  type PgApiKeys,
} from '@feedbouncer/public-api';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { enforceOrgActive } from '../tenancy/org-status.js';
import { API_KEYS, DEPS, PUBLIC_API_LIMITS } from '../tokens.js';
import type { PublicApiLimits } from './rate-limit.js';
import { API_SCOPE } from './scope.decorator.js';

export interface ApiKeyRequest extends FastifyRequest {
  apiKey: ApiKeyContext;
}

const BEARER = /^Bearer (\S+)$/i;

const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', undefined, undefined, {
    'www-authenticate': 'Bearer realm="FeedBouncer API"',
  });

/**
 * Authenticates the bearer key, rate limits it (suspended organizations included), then requires an active organization, then checks its scope.
 * Never reads cookies: the public API is a separate namespace from the dashboard.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEYS) private readonly keys: PgApiKeys,
    @Inject(PUBLIC_API_LIMITS) private readonly limits: PublicApiLimits,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DEPS) private readonly deps: AppDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<ApiKeyRequest>();
    // Read first and fail closed: a route without @RequireScope is a bug, never an open door.
    const need = this.reflector.get<ApiKeyScope | undefined>(API_SCOPE, ctx.getHandler());
    if (need === undefined) throw new Error(`route ${req.routeOptions.url} has no @RequireScope`);

    await this.limits.assertAuthBudget(req.ip);
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const apiKey = token ? await this.keys.authenticate(token) : null;
    if (!apiKey) {
      await this.limits.consumeAuthFailure(req.ip);
      throw unauthenticated();
    }
    const { limit, remaining } = await this.limits.consumeKey(apiKey.apiKeyId);
    const reply = http.getResponse<FastifyReply>();
    void reply.header('x-ratelimit-limit', String(limit));
    void reply.header('x-ratelimit-remaining', String(remaining));
    enforceOrgActive(this.deps.log, {
      organizationId: apiKey.organizationId,
      rawStatus: apiKey.organizationStatus,
      via: 'api_key',
      route: `${req.method} ${req.routeOptions.url ?? ''}`,
      apiKeyId: apiKey.apiKeyId,
    });
    if (!scopeAllows(apiKey.scope, need)) throw new ApiError(403, 'insufficient_scope');
    req.apiKey = {
      organizationId: apiKey.organizationId,
      apiKeyId: apiKey.apiKeyId,
      scope: apiKey.scope,
    };
    return true;
  }
}
