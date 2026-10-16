import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { HiddenTodayService } from './hidden-today.service.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId/hidden-comments/:hideActionId')
@UseGuards(SessionGuard, OrgAccessGuard)
export class HiddenTodayController {
  constructor(@Inject(HiddenTodayService) private readonly hidden: HiddenTodayService) {}

  @Get()
  @RequireCapability('comment.moderate')
  async get(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('hideActionId') hideActionId: string,
  ) {
    return { item: await this.hidden.get(req.org, brandId, parseUuidOr404(hideActionId)) };
  }

  /** 202 while the platform call is still pending, 200 once the row has settled. */
  @Post('unhide')
  @RequireCapability('comment.moderate')
  async unhide(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('hideActionId') hideActionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    parseBody(z.strictObject({}), body);
    const item = await this.hidden.unhide(req.org, brandId, parseUuidOr404(hideActionId));
    void reply.status(item.state === 'pending' ? 202 : 200);
    return { item };
  }
}
