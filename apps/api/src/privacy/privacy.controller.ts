import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiError } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { CreatePrivacyRequestBody, ListPrivacyRequestsQuery } from './dto.js';
import { PrivacyService } from './privacy.service.js';

@Controller('api/v1/orgs/:orgId/privacy')
@UseGuards(SessionGuard, OrgAccessGuard)
export class PrivacyController {
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}

  @Get('retention')
  @RequireCapability('privacy.read')
  retention() {
    return this.privacy.retention();
  }

  @Post('requests')
  @HttpCode(202)
  @RequireCapability('privacy.read')
  async create(@Req() req: OrgRequest, @Body() body: unknown) {
    const { id } = await this.privacy.create(req.org, parseBody(CreatePrivacyRequestBody, body));
    return { id, status: 'queued' as const };
  }

  @Get('requests')
  @RequireCapability('privacy.read')
  list(@Req() req: OrgRequest, @Query() query: unknown) {
    const q = ListPrivacyRequestsQuery.safeParse(query);
    if (!q.success) throw new ApiError(400, 'invalid_request');
    return this.privacy.list(req.org, q.data);
  }

  @Get('requests/:id')
  @RequireCapability('privacy.read')
  get(@Req() req: OrgRequest, @Param('id') id: string) {
    return this.privacy.get(req.org, parseUuidOr404(id));
  }

  @Get('requests/:id/export')
  @RequireCapability('privacy.export')
  async download(
    @Req() req: OrgRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const uuid = parseUuidOr404(id);
    const { stream, bytes } = await this.privacy.download(req.org, uuid);
    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="feedbouncer-export-${uuid}.zip"`)
      .header('content-length', bytes)
      .header('cache-control', 'no-store');
    return new StreamableFile(stream);
  }
}
