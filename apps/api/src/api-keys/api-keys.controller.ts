import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ApiKeysService } from './api-keys.service.js';
import { CreateApiKeyBody } from './dto.js';

@Controller('api/v1/orgs/:orgId/api-keys')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  @RequireCapability('api_key.manage')
  list(@Req() req: OrgRequest) {
    return this.keys.list(req.org);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('api_key.manage')
  create(
    @Req() req: OrgRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.keys.create(req.org, parseBody(CreateApiKeyBody, body));
  }

  @Post(':keyId/revoke')
  @HttpCode(200)
  @RequireCapability('api_key.manage')
  revoke(@Req() req: OrgRequest, @Param('keyId') keyId: string) {
    return this.keys.revoke(req.org, parseUuidOr404(keyId));
  }
}
