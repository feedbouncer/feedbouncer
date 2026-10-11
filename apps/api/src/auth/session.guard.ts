import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { AUTH, DEPS } from '../tokens.js';
import type { Auth } from './auth.js';
import { findUserById, type UserRow } from './users.repo.js';

export type AuthedUser = UserRow;
export interface AuthedRequest extends FastifyRequest {
  user: AuthedUser;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DEPS) private readonly deps: AppDeps,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const cookie = req.headers.cookie;
    if (!cookie) throw new ApiError(401, 'unauthenticated');
    const session = await this.auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!session) throw new ApiError(401, 'unauthenticated');
    // Re-read the user row: email_verified may have changed since the session was issued.
    const user = await findUserById(this.deps.pool, session.user.id);
    if (!user) throw new ApiError(401, 'unauthenticated');
    req.user = user;
    return true;
  }
}

export function requireVerified(user: AuthedUser): void {
  if (!user.emailVerified) {
    throw new ApiError(403, 'email_not_verified', 'Verify your email address first.');
  }
}
