import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { DEPS, PROVISIONING_LIMITS } from '../tokens.js';
import { matchCredential, PROVISIONING_TOKEN_RE } from './credential.js';
import type { ProvisioningLimits } from './rate-limit.js';

export interface ProvisioningRequest extends FastifyRequest {
  provisioning: { credentialFingerprint: string };
}

export const WWW_AUTHENTICATE = 'Bearer realm="FeedBouncer Provisioning"';

const BEARER = /^Bearer (\S+)$/i;

/**
 * Authenticates the platform service credential, and nothing else: never reads
 * cookies or API keys. Off unless configured, answering exactly like an unknown
 * route. Runs before any path id, body or lookup, so a caller without the
 * credential learns nothing about which accounts exist.
 */
@Injectable()
export class ProvisioningGuard implements CanActivate {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(PROVISIONING_LIMITS) private readonly limits: ProvisioningLimits,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.deps.env.provisioning;
    if (!config) throw notFound();
    const req = ctx.switchToHttp().getRequest<ProvisioningRequest>();
    await this.limits.assertAuthBudget(req.ip);
    const header = req.headers.authorization;
    const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
    const match = matchCredential(token, config.credentialDigests);
    if (!match) {
      await this.limits.consumeAuthFailure(req.ip);
      const reason =
        header === undefined
          ? 'missing'
          : token === undefined || !PROVISIONING_TOKEN_RE.test(token)
            ? 'malformed'
            : 'mismatch';
      this.deps.log.warn('provisioning.auth_failed', {
        reason,
        route: `${req.method} ${req.routeOptions.url ?? ''}`,
      });
      throw new ApiError(401, 'unauthenticated', undefined, undefined, {
        'www-authenticate': WWW_AUTHENTICATE,
      });
    }
    req.provisioning = { credentialFingerprint: match.fingerprint };
    return true;
  }
}
