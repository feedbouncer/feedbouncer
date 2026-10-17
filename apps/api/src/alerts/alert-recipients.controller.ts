// Public recipient confirmation: no session and no Origin check. A 256-bit
// single-purpose token (looked up by its SHA-256) is the only credential.
// Unsubscribe is in unsubscribe.plugin.ts (it needs a form parser of its own).
import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { parseBody } from '../http/validation.js';
import { AlertsService } from './alerts.service.js';
import { TokenBody } from './dto.js';

@Controller('api/v1/alert-recipients')
export class AlertRecipientsController {
  constructor(@Inject(AlertsService) private readonly alerts: AlertsService) {}

  @Post('confirm')
  @HttpCode(200)
  @RouteConfig({ publicWebhook: true })
  async confirm(@Req() req: FastifyRequest, @Body() body: unknown) {
    await this.alerts.limitPublic(req.ip);
    return this.alerts.confirm(parseBody(TokenBody, body).token);
  }
}
