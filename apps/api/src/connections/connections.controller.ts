import { Controller, Delete, Get, HttpCode, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ConnectionsService } from './connections.service.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId/connections')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly svc: ConnectionsService) {}

  @Get()
  @RequireCapability('connection.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { connections: await this.svc.list(req.org, brandId) };
  }

  @Delete(':connectionId')
  @HttpCode(204)
  @RequireCapability('connection.manage')
  async disconnect(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<void> {
    await this.svc.disconnect(req.org, brandId, connectionId);
  }
}
