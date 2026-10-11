import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import type { AppDeps } from '../deps.js';
import { DEPS } from '../tokens.js';

@Controller('api/v1/me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  @Get()
  async me(@Req() req: AuthedRequest) {
    const { rows } = await this.deps.pool.query<{
      organizationId: string;
      organizationName: string;
      role: string;
    }>(
      `SELECT o.id AS "organizationId", o.name AS "organizationName", m.role
         FROM membership m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.name, o.id`,
      [req.user.id],
    );
    const { id, email, name, emailVerified } = req.user;
    return { user: { id, email, name, emailVerified }, memberships: rows };
  }
}
