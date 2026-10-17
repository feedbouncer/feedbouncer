import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { AlertsService } from './alerts.service.js';
import { BrandAlertsBody } from './dto.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId/alerts')
@UseGuards(SessionGuard, OrgAccessGuard)
export class BrandAlertsController {
  constructor(@Inject(AlertsService) private readonly alerts: AlertsService) {}

  @Get()
  @RequireCapability('alert.read')
  get(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return this.alerts.brandView(req.org, brandId);
  }

  @Put()
  @HttpCode(200)
  @RequireCapability('alert.manage')
  put(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    return this.alerts.putBrand(req.org, brandId, parseBody(BrandAlertsBody, body));
  }
}
