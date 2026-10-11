import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ROLES } from '@feedbouncer/authz';
import { z } from 'zod';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { InvitationsService } from './invitations.service.js';

const CreateBody = z.strictObject({ email: z.string().max(400), role: z.enum(ROLES) });
const TokenBody = z.strictObject({ token: z.string().max(100) });

@Controller('api/v1/orgs/:orgId/invitations')
@UseGuards(SessionGuard, OrgAccessGuard)
export class OrgInvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Get()
  @RequireCapability('invitation.read')
  async list(@Req() req: OrgRequest) {
    return { invitations: await this.invitations.listPending(req.org) };
  }

  @Post()
  @RequireCapability('member.invite')
  async create(
    @Req() req: OrgRequest & FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { email, role } = parseBody(CreateBody, body);
    const result = await this.invitations.create(req.org, email, role, req.ip);
    void reply.status(result.status === 'already_member' ? 200 : 201);
    return result;
  }

  @Post(':invitationId/revoke')
  @HttpCode(200)
  @RequireCapability('member.invite')
  async revoke(@Req() req: OrgRequest, @Param('invitationId') invitationId: string) {
    await this.invitations.revoke(req.org, parseUuidOr404(invitationId));
    return { status: 'ok' };
  }
}

@Controller('api/v1/invitations')
@UseGuards(SessionGuard)
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post('lookup')
  @HttpCode(200)
  async lookup(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.invitations.lookup(req.user, parseBody(TokenBody, body).token);
  }

  @Post('accept')
  @HttpCode(200)
  async accept(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.invitations.accept(req.user, parseBody(TokenBody, body).token);
  }
}
