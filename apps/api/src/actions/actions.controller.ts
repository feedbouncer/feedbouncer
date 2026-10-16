import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { STEP_STATUSES, STEP_TYPES } from '@feedbouncer/actions';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ActionsService } from './actions.service.js';

const LogQuery = z.strictObject({
  ruleId: zUuid.optional(),
  commentId: zUuid.optional(),
  status: z.enum(STEP_STATUSES).optional(),
  type: z.enum(STEP_TYPES).optional(),
  before: zUuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ActionsController {
  constructor(@Inject(ActionsService) private readonly actions: ActionsService) {}

  @Get('action-capabilities')
  @RequireCapability('rule.read')
  capabilities(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return this.actions.capabilities(req.org, brandId);
  }

  @Get('action-log')
  @RequireCapability('comment.moderate')
  log(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    return this.actions.log(req.org, brandId, parseBody(LogQuery, query));
  }

  @Post('action-log/:stepId/undo')
  @HttpCode(202)
  @RequireCapability('comment.moderate')
  undo(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('stepId') stepId: string,
    @Body() body: unknown,
  ) {
    parseBody(z.strictObject({}), body);
    return this.actions.undo(req.org, brandId, parseUuidOr404(stepId));
  }
}
