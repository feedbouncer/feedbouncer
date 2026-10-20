import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { ModerationCheckService } from './moderation-check.service.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/moderation')
@UseGuards(ApiKeyGuard)
export class PublicModerationCheckController {
  constructor(@Inject(ModerationCheckService) private readonly checks: ModerationCheckService) {}

  @Post('check')
  @HttpCode(200)
  @RequireScope('moderate')
  check(@Req() req: ApiKeyRequest, @Body() body: unknown) {
    return this.checks.check(req.apiKey, body);
  }
}
