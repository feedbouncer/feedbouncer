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
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { PoliciesService } from './policies.service.js';

@Controller('api/v1/orgs/:orgId/brands/:brandId')
@UseGuards(SessionGuard, OrgAccessGuard)
export class PoliciesController {
  constructor(@Inject(PoliciesService) private readonly policies: PoliciesService) {}

  @Get('policies')
  @RequireCapability('rule.read')
  list(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return this.policies.list(req.org, brandId);
  }

  @Post('policies')
  @HttpCode(201)
  @RequireCapability('rule.write')
  create(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    return this.policies.create(req.org, brandId, body);
  }

  @Get('policies/:policyId')
  @RequireCapability('rule.read')
  get(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('policyId') policyId: string,
  ) {
    return this.policies.get(req.org, brandId, parseUuidOr404(policyId));
  }

  @Patch('policies/:policyId')
  @RequireCapability('rule.write')
  update(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('policyId') policyId: string,
    @Body() body: unknown,
  ) {
    return this.policies.update(req.org, brandId, parseUuidOr404(policyId), body);
  }

  @Delete('policies/:policyId')
  @HttpCode(204)
  @RequireCapability('rule.write')
  async archive(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('policyId') policyId: string,
  ) {
    await this.policies.archive(req.org, brandId, parseUuidOr404(policyId));
  }

  @Post('policies/:policyId/runs')
  @HttpCode(202)
  @RequireCapability('rule.write')
  startRun(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('policyId') policyId: string,
    @Body() body: unknown,
  ) {
    return this.policies.startRun(req.org, brandId, parseUuidOr404(policyId), body);
  }

  @Post('policy-previews')
  @HttpCode(202)
  @RequireCapability('rule.write')
  startPreview(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    return this.policies.startPreview(req.org, brandId, body);
  }

  @Get('policy-previews/:previewId')
  @RequireCapability('rule.read')
  preview(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('previewId') previewId: string,
  ) {
    return this.policies.preview(req.org, brandId, parseUuidOr404(previewId));
  }
}
