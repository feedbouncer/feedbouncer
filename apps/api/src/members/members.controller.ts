import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ROLES } from '@feedbouncer/authz';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { MembersService } from './members.service.js';

const ChangeRole = z.strictObject({ role: z.enum(ROLES) });

@Controller('api/v1/orgs/:orgId/members')
@UseGuards(SessionGuard, OrgAccessGuard)
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get()
  @RequireCapability('member.read')
  async list(@Req() req: OrgRequest) {
    return { members: await this.members.list(req.org) };
  }

  @Patch(':userId')
  @RequireCapability('member.change_role')
  async changeRole(@Req() req: OrgRequest, @Param('userId') userId: string, @Body() body: unknown) {
    const { role } = parseBody(ChangeRole, body);
    return { member: await this.members.changeRole(req.org, parseUuidOr404(userId), role) };
  }

  // Every member may call this (leaving is allowed for all), so the guard
  // capability is intentionally weaker than the action: the service decides
  // with canRemoveMember, using the session user to detect self-removal.
  @Delete(':userId')
  @HttpCode(204)
  @RequireCapability('member.read')
  async remove(@Req() req: OrgRequest, @Param('userId') userId: string) {
    await this.members.remove(req.org, parseUuidOr404(userId));
  }
}
