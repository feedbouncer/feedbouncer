import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { RulesService } from './rules.service.js';

const DomainBody = z.strictObject({ domain: z.string().max(2048) });

@Controller('api/v1/orgs/:orgId/brands/:brandId/domains')
@UseGuards(SessionGuard, OrgAccessGuard)
export class DomainsController {
  constructor(@Inject(RulesService) private readonly rules: RulesService) {}

  @Get()
  @RequireCapability('rule.read')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { domains: await this.rules.listDomains(req.org, brandId) };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('brand.write')
  add(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    return this.rules.addDomain(req.org, brandId, parseBody(DomainBody, body).domain);
  }

  @Delete(':domainId')
  @HttpCode(204)
  @RequireCapability('brand.write')
  async remove(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('domainId') domainId: string,
  ) {
    await this.rules.removeDomain(req.org, brandId, parseUuidOr404(domainId));
  }
}
