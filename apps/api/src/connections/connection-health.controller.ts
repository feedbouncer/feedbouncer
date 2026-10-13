import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ConnectionHealthService } from './connection-health.service.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId/connections')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ConnectionHealthController {
  constructor(@Inject(ConnectionHealthService) private readonly svc: ConnectionHealthService) {}

  @Get('health')
  @RequireCapability('connection.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { connections: await this.svc.list(req.org, parseUuidOr404(brandId)) };
  }
}
