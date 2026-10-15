import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CATEGORIES } from '@feedbouncer/classifier';
import { RULE_ACTIONS, RULE_KINDS, RULE_MODES } from '@feedbouncer/rules';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { RulesService } from './rules.service.js';

// The cursor is the sequence of the last decision of the previous page.
const CURSOR = /^[1-9][0-9]{0,17}$/;

const ActivityQuery = z.strictObject({
  ruleId: zUuid.optional(),
  kind: z.enum(RULE_KINDS).optional(),
  outcome: z.enum(RULE_ACTIONS).optional(),
  mode: z.enum(RULE_MODES).optional(),
  source: z.enum(['rule', 'classifier']).optional(),
  category: z.enum(CATEGORIES).optional(),
  before: z.string().regex(CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId/rule-activity')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ActivityController {
  constructor(@Inject(RulesService) private readonly rules: RulesService) {}

  @Get()
  @RequireCapability('rule.read')
  list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    const q = parseBody(ActivityQuery, query);
    return this.rules.activity(req.org, brandId, q);
  }
}
