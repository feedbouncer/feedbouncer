import { Controller, Get, Inject, Param, Req, UseGuards } from '@nestjs/common';
import type pg from 'pg';
import { loadPublicAction, toActionResource } from '@feedbouncer/public-api';
import { notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/actions')
@UseGuards(ApiKeyGuard)
export class PublicActionsController {
  readonly #pool: pg.Pool;

  constructor(@Inject(DEPS) deps: AppDeps) {
    this.#pool = deps.pool;
  }

  @Get(':id')
  @RequireScope('read')
  async get(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const row = await loadPublicAction(this.#pool, req.apiKey.organizationId, parseUuidOr404(id));
    if (!row) throw notFound();
    return toActionResource(row);
  }
}
