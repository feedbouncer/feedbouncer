import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ActionsService } from '../actions/actions.service.js';
import { RulesService } from './rules.service.js';

const OrderBody = z.strictObject({ ruleIds: z.array(zUuid).max(200) });
const SimulateBody = z.strictObject({ commentId: zUuid });

@Controller('api/v1/orgs/:orgId/brands/:brandId/rules')
@UseGuards(SessionGuard, OrgAccessGuard)
export class RulesController {
  constructor(
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ActionsService) private readonly actions: ActionsService,
  ) {}

  @Get()
  @RequireCapability('rule.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { rules: await this.rules.list(req.org, brandId) };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('rule.write')
  create(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    return this.rules.create(req.org, brandId, body);
  }

  @Put('order')
  @RequireCapability('rule.write')
  async reorder(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    const { ruleIds } = parseBody(OrderBody, body);
    return { rules: await this.rules.reorder(req.org, brandId, ruleIds) };
  }

  @Get(':ruleId')
  @RequireCapability('rule.read')
  get(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Param('ruleId') ruleId: string) {
    return this.rules.get(req.org, brandId, parseUuidOr404(ruleId));
  }

  @Patch(':ruleId')
  @RequireCapability('rule.write')
  update(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
  ) {
    return this.rules.update(req.org, brandId, parseUuidOr404(ruleId), body);
  }

  @Post(':ruleId/simulate')
  @HttpCode(200)
  @RequireCapability('rule.read')
  simulate(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
  ) {
    const { commentId } = parseBody(SimulateBody, body);
    return this.actions.simulate(req.org, brandId, parseUuidOr404(ruleId), commentId);
  }

  @Delete(':ruleId')
  @HttpCode(204)
  @RequireCapability('rule.write')
  async archive(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('ruleId') ruleId: string,
  ) {
    await this.rules.archive(req.org, brandId, parseUuidOr404(ruleId));
  }
}
