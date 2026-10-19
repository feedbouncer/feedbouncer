import { Body, Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CreateReplyBody, PgIdempotency, routeSpec } from '@feedbouncer/public-api';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { runIdempotent } from './idempotent.js';
import { PublicModerationService } from './moderation.service.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/comments')
@UseGuards(ApiKeyGuard)
export class PublicRepliesController {
  readonly #idempotency: PgIdempotency;

  constructor(
    @Inject(DEPS) deps: AppDeps,
    @Inject(PublicModerationService) private readonly moderation: PublicModerationService,
  ) {
    this.#idempotency = new PgIdempotency(deps.pool);
  }

  @Post(':id/replies')
  @RequireScope('write')
  async reply(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
  ) {
    const spec = routeSpec('replyToComment');
    const id = parseUuidOr404(rawId);
    const body = parseBody(CreateReplyBody, rawBody);
    return runIdempotent(this.#idempotency, req, reply, spec, { id }, body, (idempotencyKey) =>
      this.moderation.reply(req.apiKey, id, body.text, idempotencyKey),
    );
  }
}
