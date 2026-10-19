import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import type pg from 'pg';
import {
  encodeCursor,
  ListCommentsQuery,
  listPublicComments,
  loadPublicComment,
  toCommentResource,
} from '@feedbouncer/public-api';
import { notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { decodePageCursor, parseDateRange } from './pagination.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/comments')
@UseGuards(ApiKeyGuard)
export class PublicCommentsController {
  readonly #pool: pg.Pool;

  constructor(@Inject(DEPS) deps: AppDeps) {
    this.#pool = deps.pool;
  }

  @Get()
  @RequireScope('read')
  async list(@Req() req: ApiKeyRequest, @Query() rawQuery: unknown) {
    const q = parseBody(ListCommentsQuery, rawQuery);
    const range = parseDateRange(q.postedFrom, q.postedTo, { from: 'postedFrom', to: 'postedTo' });
    const filters = {
      status: q.status,
      brandId: q.brandId,
      postedFrom: q.postedFrom,
      postedTo: q.postedTo,
    };
    const after = decodePageCursor(q.cursor, filters);
    const { rows, next } = await listPublicComments(
      this.#pool,
      req.apiKey.organizationId,
      { status: q.status, brandId: q.brandId, postedFrom: range.from, postedTo: range.to },
      { limit: q.limit, after },
    );
    return { data: rows.map(toCommentResource), nextCursor: next && encodeCursor(next, filters) };
  }

  @Get(':id')
  @RequireScope('read')
  async get(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const row = await loadPublicComment(this.#pool, req.apiKey.organizationId, parseUuidOr404(id));
    if (!row) throw notFound();
    return toCommentResource(row);
  }
}
