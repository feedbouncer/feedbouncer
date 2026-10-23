import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PgScanStore, ScanPageOption, ScanView, SharedScanView } from '@feedbouncer/scan';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS, SCAN_LIMITS, SCAN_STORE } from '../tokens.js';
import type { ScanRateLimits } from './scan-rate-limit.js';
import { ScanOAuthService } from './scan-oauth.service.js';
import { ScanService } from './scan.service.js';
import { clearVisitorCookieHeader, ensureVisitor, findVisitor, requireVisitor } from './visitor.js';

/** With SCAN_TOOL_ENABLED=false (or no Facebook app) every scan route is a plain 404. */
@Injectable()
export class ScanEnabledGuard implements CanActivate {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  canActivate(): boolean {
    if (!this.deps.env.scan.enabled || !this.deps.env.facebook) throw notFound();
    return true;
  }
}

const EmptyBody = z.strictObject({});
const CreateScanBody = z.strictObject({
  grantId: z.uuid(),
  pageId: z.string().regex(/^\d{1,32}$/),
});

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
    @Inject(ScanService) private readonly scans: ScanService,
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
    parseBody(EmptyBody, body);
    await this.limits.authorize(req.ip);
    const visitorId = await ensureVisitor(this.store, req, reply, this.#secureCookie, new Date());
    const started = await this.oauth.start(visitorId);
    this.deps.metrics.scanAuthorize.inc();
    return started;
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

  @Get('grants/:grantId')
  async grant(
    @Req() req: FastifyRequest,
    @Param('grantId') grantId: string,
  ): Promise<{ pages: ScanPageOption[]; instagramGranted: boolean }> {
    await this.limits.visitorRead(req.ip);
    const visitorId = await this.#visitor(req);
    return this.scans.grant(visitorId, parseUuidOr404(grantId));
  }

  @Post('scans')
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Body() body: unknown): Promise<{ scanId: string }> {
    const input = parseBody(CreateScanBody, body);
    const visitorId = await this.#visitor(req);
    return this.scans.create(visitorId, req.ip, input);
  }

  @Get('scans')
  async list(@Req() req: FastifyRequest): Promise<{ scans: ScanView[] }> {
    await this.limits.visitorRead(req.ip);
    return this.scans.list(await this.#visitor(req));
  }

  @Get('scans/:scanId')
  async get(@Req() req: FastifyRequest, @Param('scanId') scanId: string): Promise<ScanView> {
    await this.limits.visitorRead(req.ip);
    const visitorId = await this.#visitor(req);
    return this.scans.get(visitorId, parseUuidOr404(scanId));
  }

  @Delete('scans/:scanId')
  @HttpCode(204)
  async delete(@Req() req: FastifyRequest, @Param('scanId') scanId: string): Promise<void> {
    const visitorId = await this.#visitor(req);
    await this.scans.delete(visitorId, parseUuidOr404(scanId));
  }

  @Put('scans/:scanId/share')
  @HttpCode(200)
  async share(
    @Req() req: FastifyRequest,
    @Param('scanId') scanId: string,
    @Body() body: unknown,
  ): Promise<{ shareUrl: string }> {
    parseBody(EmptyBody, body);
    const visitorId = await this.#visitor(req);
    return this.scans.share(visitorId, parseUuidOr404(scanId));
  }

  @Delete('scans/:scanId/share')
  @HttpCode(204)
  async unshare(@Req() req: FastifyRequest, @Param('scanId') scanId: string): Promise<void> {
    const visitorId = await this.#visitor(req);
    await this.scans.unshare(visitorId, parseUuidOr404(scanId));
  }

  /** A shared result, read by its link token alone. */
  @Get('shared/:token')
  async shared(@Req() req: FastifyRequest, @Param('token') token: string): Promise<SharedScanView> {
    await this.limits.sharedRead(req.ip);
    return this.scans.shared(token);
  }

  /** Deletes the visitor with everything it owns and clears its cookie. */
  @Delete('me')
  @HttpCode(204)
  async deleteMe(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.scans.deleteVisitor(await this.#visitor(req));
    void reply.header('set-cookie', clearVisitorCookieHeader(this.#secureCookie));
  }

  /** The result page's sign-up link. The target is fixed; the query is ignored. */
  @Get('cta')
  cta(@Res() reply: FastifyReply): void {
    this.deps.metrics.scanCtaClicks.inc();
    void reply
      .status(303)
      .header('location', new URL('/sign-up?from=scan', this.deps.env.publicWebUrl).href)
      .header('cache-control', 'no-store')
      .send();
  }

  #visitor(req: FastifyRequest): Promise<string> {
    return requireVisitor(this.store, req, new Date());
  }
}
