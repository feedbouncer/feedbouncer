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
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { RuleChangesService } from './rule-changes.service.js';

const ListQuery = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'stale']).optional(),
});
const DecisionBody = z.strictObject({ note: z.string().trim().min(1).max(500).optional() });

// Session only: an API key can propose a rule change but never decide one.
@Controller('api/v1/orgs/:orgId/brands/:brandId/rule-changes')
@UseGuards(SessionGuard, OrgAccessGuard)
export class RuleChangesController {
  constructor(@Inject(RuleChangesService) private readonly changes: RuleChangesService) {}

  @Get()
  @RequireCapability('rule.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    const { status } = parseBody(ListQuery, query);
    return { changes: await this.changes.list(req.org, brandId, status) };
  }

  @Get(':changeId')
  @RequireCapability('rule.read')
  get(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('changeId') changeId: string,
  ) {
    return this.changes.get(req.org, brandId, parseUuidOr404(changeId));
  }

  @Post(':changeId/approve')
  @HttpCode(200)
  @RequireCapability('rule.write')
  approve(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ) {
    const { note } = parseBody(DecisionBody, body);
    return this.changes.approve(req.org, brandId, parseUuidOr404(changeId), note);
  }

  @Post(':changeId/reject')
  @HttpCode(200)
  @RequireCapability('rule.write')
  reject(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('changeId') changeId: string,
    @Body() body: unknown,
  ) {
    const { note } = parseBody(DecisionBody, body);
    return this.changes.reject(req.org, brandId, parseUuidOr404(changeId), note);
  }
}
