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
import { z } from 'zod';
import { GRAPH_ID } from '@feedbouncer/connector-facebook';
import type { Platform } from '@feedbouncer/connectors';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ConnectablePlatformPipe } from './connectable-platform.pipe.js';
import { OAuthConnectService } from './oauth-connect.service.js';

const AuthorizeBody = z.strictObject({ reconnectConnectionId: zUuid.optional() });
// Every account-selection platform so far is a Meta one, whose ids are Graph ids.
const ConnectBody = z.strictObject({
  accountIds: z.array(z.string().regex(GRAPH_ID)).min(1).max(50),
});

/**
 * The connect flow for platforms where the user picks accounts after consent.
 * `:platform` is resolved by ConnectablePlatformPipe (404 platform_not_configured
 * for anything else); the guards run first, so a member still gets 403.
 */
@Controller('api/v1/orgs/:orgId/brands/:brandId/connections/:platform')
@UseGuards(SessionGuard, OrgAccessGuard)
export class OAuthConnectController {
  constructor(@Inject(OAuthConnectService) private readonly svc: OAuthConnectService) {}

  @Post('authorize')
  @HttpCode(200)
  @RequireCapability('connection.manage')
  async authorize(
    @Req() req: OrgRequest,
    @Param('platform', ConnectablePlatformPipe) platform: Platform,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    const { reconnectConnectionId } = parseBody(AuthorizeBody, body);
    return {
      authorizationUrl: await this.svc.authorize(platform, req.org, brandId, reconnectConnectionId),
    };
  }

  @Get('grants/:grantId')
  @RequireCapability('connection.manage')
  async grant(
    @Req() req: OrgRequest,
    @Param('platform', ConnectablePlatformPipe) platform: Platform,
    @Param('brandId') brandId: string,
    @Param('grantId') grantId: string,
  ) {
    const id = parseUuidOr404(grantId);
    const accounts = await this.svc.grantAccounts(platform, req.org, brandId, id);
    return { accounts };
  }

  @Post('grants/:grantId/connect')
  @HttpCode(200)
  @RequireCapability('connection.manage')
  async connect(
    @Req() req: OrgRequest,
    @Param('platform', ConnectablePlatformPipe) platform: Platform,
    @Param('brandId') brandId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const id = parseUuidOr404(grantId);
    const { accountIds } = parseBody(ConnectBody, body);
    return { results: await this.svc.connect(platform, req.org, brandId, id, accountIds) };
  }
}

/**
 * Where the platform sends the browser back. Session only: the organization and
 * brand come from the signed-in user's own pending state (which must also be
 * for this platform), and the redirect goes to a web-app path built from ids
 * and fixed codes.
 */
@Controller('api/v1/oauth/:platform')
@UseGuards(SessionGuard)
export class OAuthCallbackController {
  constructor(@Inject(OAuthConnectService) private readonly svc: OAuthConnectService) {}

  @Get('callback')
  async callback(
    @Req() req: AuthedRequest,
    @Param('platform', ConnectablePlatformPipe) platform: Platform,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const query = req.query as Record<string, unknown>;
    const location = await this.svc.complete(platform, req.user.id, query);
    void reply.status(302).header('location', location).header('cache-control', 'no-store').send();
  }
}
