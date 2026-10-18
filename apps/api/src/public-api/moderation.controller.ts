import { Body, Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PgIdempotency, routeSpec } from '@feedbouncer/public-api';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { runIdempotent } from './idempotent.js';
import { PublicModerationService } from './moderation.service.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/comments')
@UseGuards(ApiKeyGuard)
export class PublicModerationController {
  readonly #idempotency: PgIdempotency;

  constructor(
    @Inject(DEPS) deps: AppDeps,
    @Inject(PublicModerationService) private readonly moderation: PublicModerationService,
  ) {
    this.#idempotency = new PgIdempotency(deps.pool);
  }

  @Post(':id/hide')
  @RequireScope('write')
  hide(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.#run('hide', req, reply, id, body);
  }

  @Post(':id/unhide')
  @RequireScope('write')
  unhide(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.#run('unhide', req, reply, id, body);
  }

  async #run(
    kind: 'hide' | 'unhide',
    req: ApiKeyRequest,
    reply: FastifyReply,
    rawId: string,
    rawBody: unknown,
  ): Promise<unknown> {
    const spec = routeSpec(`${kind}Comment`);
    const id = parseUuidOr404(rawId);
    const body = parseBody(spec.body!, rawBody);
    return runIdempotent(this.#idempotency, req, reply, spec, { id }, body, (idempotencyKey) =>
      this.moderation.moderate(req.apiKey, kind, id, idempotencyKey),
    );
  }
}
