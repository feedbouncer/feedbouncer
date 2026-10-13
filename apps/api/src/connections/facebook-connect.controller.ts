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
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { FacebookConnectService } from './facebook-connect.service.js';

const AuthorizeBody = z.strictObject({ reconnectConnectionId: zUuid.optional() });
const ConnectBody = z.strictObject({
  pageIds: z.array(z.string().regex(GRAPH_ID)).min(1).max(50),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId/connections/facebook')
@UseGuards(SessionGuard, OrgAccessGuard)
export class FacebookConnectController {
  constructor(@Inject(FacebookConnectService) private readonly svc: FacebookConnectService) {}

  @Post('authorize')
  @HttpCode(200)
  @RequireCapability('connection.manage')
  async authorize(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    const { reconnectConnectionId } = parseBody(AuthorizeBody, body);
    return { authorizationUrl: await this.svc.authorize(req.org, brandId, reconnectConnectionId) };
  }

  @Get('grants/:grantId')
  @RequireCapability('connection.manage')
  async grant(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('grantId') grantId: string,
  ) {
    const accounts = await this.svc.grantAccounts(req.org, brandId, parseUuidOr404(grantId));
    return { accounts };
  }

  @Post('grants/:grantId/connect')
  @HttpCode(200)
  @RequireCapability('connection.manage')
  async connect(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const id = parseUuidOr404(grantId);
    const { pageIds } = parseBody(ConnectBody, body);
    return { results: await this.svc.connect(req.org, brandId, id, pageIds) };
  }
}

/**
 * Where Facebook sends the browser back. Session only: the organization and
 * brand come from the signed-in user's own pending state, and the redirect goes
 * to a web-app path built from ids and fixed codes.
 */
@Controller('api/v1/oauth/facebook')
@UseGuards(SessionGuard)
export class FacebookCallbackController {
  constructor(@Inject(FacebookConnectService) private readonly svc: FacebookConnectService) {}

  @Get('callback')
  async callback(@Req() req: AuthedRequest, @Res() reply: FastifyReply): Promise<void> {
    const location = await this.svc.complete(req.user.id, req.query as Record<string, unknown>);
    void reply.status(302).header('location', location).header('cache-control', 'no-store').send();
  }
}
