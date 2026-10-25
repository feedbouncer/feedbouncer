import { Body, Controller, Get, Inject, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { YouTubeConnectionService } from './youtube.service.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId/connections/:connectionId/youtube')
@UseGuards(SessionGuard, OrgAccessGuard)
export class YouTubeConnectionController {
  constructor(@Inject(YouTubeConnectionService) private readonly svc: YouTubeConnectionService) {}

  @Get()
  @RequireCapability('connection.read')
  status(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('connectionId') connectionId: string,
  ) {
    return this.svc.status(req.org, brandId, connectionId);
  }

  @Patch()
  @RequireCapability('connection.manage')
  update(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    return this.svc.update(req.org, brandId, connectionId, body);
  }

  @Get('quota')
  @RequireCapability('connection.read')
  quota(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('connectionId') connectionId: string,
    @Query('day') day: unknown,
  ) {
    return this.svc.quota(req.org, brandId, connectionId, day);
  }
}
