import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Capability, type Role } from '@feedbouncer/authz';
import type { AuthedRequest } from '../auth/session.guard.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import { CAPABILITY } from './capability.decorator.js';
import { findMembership } from './memberships.repo.js';

export interface OrgContext {
  organizationId: string;
  actorUserId: string;
  role: Role;
}
export interface OrgRequest extends AuthedRequest {
  org: OrgContext;
}

/** Runs after SessionGuard. Non-members get the same 404 as a missing organization. */
@Injectable()
export class OrgAccessGuard implements CanActivate {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OrgRequest>();
    const params = req.params as Record<string, string | undefined>;
    // Read first and fail closed: a route without @RequireCapability is a bug,
    // never an open door, and must not depend on who is asking.
    const cap = this.reflector.get<Capability | undefined>(CAPABILITY, ctx.getHandler());
    if (cap === undefined)
      throw new Error(`route ${req.routeOptions.url} has no @RequireCapability`);
    const organizationId = parseUuidOr404(params.orgId);
    const m = await findMembership(this.deps.pool, organizationId, req.user.id);
    if (!m) throw notFound();
    req.org = { organizationId, actorUserId: req.user.id, role: m.role };
    if (!can(m.role, cap)) throw new ApiError(403, 'forbidden');
    return true;
  }
}
