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
import { z } from 'zod';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { ReportsService } from './reports.service.js';

const SubscriptionBody = z.strictObject({ subscribed: z.boolean() });

// The caller's own subscriptions. Not under /orgs/:orgId: setSubscription answers 404
// unless the caller is an owner or admin of the organization.
@Controller('api/v1/me/report-subscriptions')
@UseGuards(SessionGuard)
export class MeReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return { subscriptions: await this.reports.listSubscriptions(req.user.id) };
  }

  @Put(':organizationId')
  @HttpCode(204)
  async set(
    @Req() req: AuthedRequest,
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { subscribed } = parseBody(SubscriptionBody, body);
    await this.reports.setSubscription(req.user.id, parseUuidOr404(organizationId), subscribed);
  }
}
