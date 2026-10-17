import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { AlertsService } from './alerts.service.js';
import { EmailCreateBody, SlackCreateBody, SlackReconnectBody } from './dto.js';

@Controller('api/v1/orgs/:orgId/alert-channels')
@UseGuards(SessionGuard, OrgAccessGuard)
export class AlertChannelsController {
  constructor(@Inject(AlertsService) private readonly alerts: AlertsService) {}

  @Get()
  @RequireCapability('alert.read')
  list(@Req() req: OrgRequest) {
    return this.alerts.list(req.org);
  }

  @Post('slack')
  @HttpCode(201)
  @RequireCapability('alert.manage')
  createSlack(@Req() req: OrgRequest, @Body() body: unknown) {
    return this.alerts.createSlack(req.org, parseBody(SlackCreateBody, body));
  }

  @Put(':channelId/slack')
  @HttpCode(200)
  @RequireCapability('alert.manage')
  reconnectSlack(
    @Req() req: OrgRequest,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
  ) {
    const id = parseUuidOr404(channelId);
    return this.alerts.reconnectSlack(req.org, id, parseBody(SlackReconnectBody, body).webhookUrl);
  }

  @Post('email')
  @HttpCode(201)
  @RequireCapability('alert.manage')
  createEmail(@Req() req: OrgRequest, @Body() body: unknown) {
    const b = parseBody(EmailCreateBody, body);
    return this.alerts.createEmail(
      req.org,
      { email: b.email, ...(b.label !== undefined && { label: b.label }) },
      req.ip,
    );
  }

  @Post(':channelId/resend-confirmation')
  @HttpCode(202)
  @RequireCapability('alert.manage')
  async resend(@Req() req: OrgRequest, @Param('channelId') channelId: string) {
    await this.alerts.resendConfirmation(req.org, parseUuidOr404(channelId), req.ip);
    return { status: 'sent' };
  }

  @Post(':channelId/test')
  @HttpCode(200)
  @RequireCapability('alert.manage')
  test(@Req() req: OrgRequest, @Param('channelId') channelId: string) {
    return this.alerts.test(req.org, parseUuidOr404(channelId));
  }

  @Delete(':channelId')
  @HttpCode(204)
  @RequireCapability('alert.manage')
  async remove(@Req() req: OrgRequest, @Param('channelId') channelId: string): Promise<void> {
    await this.alerts.remove(req.org, parseUuidOr404(channelId));
  }
}
