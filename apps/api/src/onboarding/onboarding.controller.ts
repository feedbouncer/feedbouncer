import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiError } from '../http/errors.js';
import { parseBody, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { OnboardingService } from './onboarding.service.js';

const Empty = z.strictObject({});
const BrandBody = z.strictObject({ brandId: zUuid });

@Controller('api/v1/orgs/:orgId/onboarding')
@UseGuards(SessionGuard, OrgAccessGuard)
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly svc: OnboardingService) {}

  @Get()
  @RequireCapability('org.update')
  get(@Req() req: OrgRequest) {
    return this.svc.get(req.org);
  }

  @Post('start')
  @HttpCode(200)
  @RequireCapability('org.update')
  start(@Req() req: OrgRequest, @Body() body: unknown) {
    parseBody(Empty, body);
    return this.svc.start(req.org);
  }

  @Put('brand')
  @RequireCapability('org.update')
  brand(@Req() req: OrgRequest, @Body() body: unknown) {
    return this.svc.setBrand(req.org, parseBody(BrandBody, body).brandId);
  }

  @Post('connect/complete')
  @HttpCode(200)
  @RequireCapability('org.update')
  completeConnect(@Req() req: OrgRequest, @Body() body: unknown) {
    parseBody(Empty, body);
    return this.svc.completeConnect(req.org);
  }

  @Post('dismiss')
  @HttpCode(200)
  @RequireCapability('org.update')
  dismiss(@Req() req: OrgRequest, @Body() body: unknown) {
    parseBody(Empty, body);
    return this.svc.dismiss(req.org);
  }

  @Post('rerun')
  @HttpCode(200)
  @RequireCapability('org.update')
  rerun(@Req() req: OrgRequest, @Body() body: unknown) {
    // Anything but confirm === true is unconfirmed (422), including a malformed body.
    if ((body as { confirm?: unknown } | null)?.confirm !== true)
      throw new ApiError(422, 'onboarding_rerun_unconfirmed');
    return this.svc.rerun(req.org);
  }
}
