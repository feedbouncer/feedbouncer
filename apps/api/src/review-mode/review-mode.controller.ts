import {
  Body,
  Controller,
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
import { ReviewModeService } from './review-mode.service.js';

const EndBody = z.strictObject({
  pending: z.enum(['leave', 'dismiss', 'approve']),
  confirm: z.literal(true).optional(),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ReviewModeController {
  constructor(@Inject(ReviewModeService) private readonly svc: ReviewModeService) {}

  @Get('review-mode')
  @RequireCapability('brand.read')
  status(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return this.svc.status(req.org, brandId);
  }

  @Post('connections/:connectionId/review-mode/end')
  @HttpCode(200)
  @RequireCapability('connection.manage')
  end(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    return this.svc.end(req.org, brandId, parseUuidOr404(connectionId), parseBody(EndBody, body));
  }
}
