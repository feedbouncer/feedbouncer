import { Body, Controller, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  IDEMPOTENCY_KEY,
  IdempotencyError,
  PgIdempotency,
  requestFingerprint,
  routeSpec,
  type StoredResponse,
} from '@feedbouncer/public-api';
import { ApiError, errorBody } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
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
    const header = req.headers['idempotency-key'];
    if (header !== undefined && (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)))
      throw new ApiError(400, 'invalid_idempotency_key');

    let result: Awaited<ReturnType<PgIdempotency['run']>>;
    try {
      result = await this.#idempotency.run(
        req.apiKey,
        header,
        requestFingerprint(spec.id, { id }, body),
        async (): Promise<StoredResponse> => {
          try {
            return await this.moderation.moderate(req.apiKey, kind, id, header);
          } catch (err) {
            if (err instanceof ApiError && err.status < 500)
              return { status: err.status, body: errorBody(err) };
            throw err;
          }
        },
      );
    } catch (err) {
      if (err instanceof IdempotencyError) throw new ApiError(err.status, err.code);
      throw err;
    }
    void reply.status(result.status);
    if (result.replayed) void reply.header('idempotent-replayed', 'true');
    return result.body;
  }
}
