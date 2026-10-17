import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ReportsService } from './reports.service.js';

const WeeklyQuery = z.strictObject({ week: z.string().optional() });

@Controller('api/v1/orgs/:orgId/reports')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get('weekly')
  @RequireCapability('report.read')
  weekly(@Req() req: OrgRequest, @Query() query: unknown) {
    return this.reports.weekly(req.org, parseBody(WeeklyQuery, query).week);
  }
}
