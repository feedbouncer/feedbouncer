import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import * as z from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { AdsService } from './ads.service.js';

const ListQuery = z.strictObject({
  connectionId: zUuid.optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId/ads')
@UseGuards(SessionGuard, OrgAccessGuard)
export class AdsController {
  constructor(@Inject(AdsService) private readonly svc: AdsService) {}

  @Get()
  @RequireCapability('connection.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    const q = parseBody(ListQuery, query);
    return this.svc.list(req.org, brandId, {
      limit: q.limit,
      ...(q.connectionId !== undefined && { connectionId: q.connectionId }),
      ...(q.cursor !== undefined && { cursor: q.cursor }),
    });
  }
}
