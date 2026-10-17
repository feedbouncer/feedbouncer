import { Body, Controller, Get, HttpCode, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { RoleGrantsService } from './role-grants.service.js';

const SetGrant = z.strictObject({
  role: z.literal('member'),
  capability: z.literal('comment.reply'),
  granted: z.boolean(),
});

@Controller('api/v1/orgs/:orgId/role-grants')
@UseGuards(SessionGuard, OrgAccessGuard)
export class RoleGrantsController {
  constructor(@Inject(RoleGrantsService) private readonly grants: RoleGrantsService) {}

  @Get()
  @RequireCapability('member.read')
  async list(@Req() req: OrgRequest) {
    return { grants: await this.grants.list(req.org) };
  }

  @Put()
  @HttpCode(200)
  @RequireCapability('member.change_role')
  async set(@Req() req: OrgRequest, @Body() body: unknown) {
    return { grants: await this.grants.set(req.org, parseBody(SetGrant, body)) };
  }
}
