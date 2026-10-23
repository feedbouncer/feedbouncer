import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  Res,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PgScanStore } from '@feedbouncer/scan';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { parseBody } from '../http/validation.js';
import { DEPS, SCAN_LIMITS, SCAN_STORE } from '../tokens.js';
import type { ScanRateLimits } from './scan-rate-limit.js';
import { ScanOAuthService } from './scan-oauth.service.js';
import { ensureVisitor, findVisitor } from './visitor.js';

/** With SCAN_TOOL_ENABLED=false (or no Facebook app) every scan route is a plain 404. */
@Injectable()
export class ScanEnabledGuard implements CanActivate {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  canActivate(): boolean {
    if (!this.deps.env.scan.enabled || !this.deps.env.facebook) throw notFound();
    return true;
  }
}

const AuthorizeBody = z.strictObject({});

/**
 * The anonymous free scan. A visitor is identified by an opaque cookie only;
 * state-changing routes keep the global Origin check.
 */
@Controller('api/v1/scan')
@UseGuards(ScanEnabledGuard)
export class ScanController {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(SCAN_STORE) private readonly store: PgScanStore,
    @Inject(SCAN_LIMITS) private readonly limits: ScanRateLimits,
    @Inject(ScanOAuthService) private readonly oauth: ScanOAuthService,
  ) {}

  get #secureCookie(): boolean {
    return this.deps.env.publicWebUrl.protocol === 'https:';
  }

  @Post('authorize')
  @HttpCode(200)
  async authorize(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<{ authorizeUrl: string }> {
    parseBody(AuthorizeBody, body);
    await this.limits.authorize(req.ip);
    const visitorId = await ensureVisitor(this.store, req, reply, this.#secureCookie, new Date());
    return this.oauth.start(visitorId);
  }

  /** Where Facebook sends the browser back: always a 303 to a /scan page of the web app. */
  @Get('oauth/meta/callback')
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    let redirectTo: string;
    try {
      const visitorId = await findVisitor(this.store, req, new Date());
      ({ redirectTo } = await this.oauth.complete(visitorId, req.query));
    } catch (err) {
      this.deps.log.error('scan.callback_failed', {
        errorName: err instanceof Error ? err.name : 'NonError',
      });
      redirectTo = '/scan?error=internal';
    }
    void reply
      .status(303)
      .header('location', new URL(redirectTo, this.deps.env.publicWebUrl).href)
      .header('cache-control', 'no-store')
      .send();
  }
}
