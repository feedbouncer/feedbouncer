import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import type pg from 'pg';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  ListCommentsQuery,
  listPublicComments,
  loadPublicComment,
  toCommentResource,
} from '@feedbouncer/public-api';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
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
    const postedFrom = q.postedFrom ? new Date(q.postedFrom) : undefined;
    const postedTo = q.postedTo ? new Date(q.postedTo) : undefined;
    if (postedFrom && postedTo && postedFrom >= postedTo) {
      throw new ApiError(400, 'invalid_request', 'postedFrom must be before postedTo.');
    }
    const filters = {
      status: q.status,
      brandId: q.brandId,
      postedFrom: q.postedFrom,
      postedTo: q.postedTo,
    };
    let after: { t: Date; id: string } | undefined;
    if (q.cursor !== undefined) {
      try {
        after = decodeCursor(q.cursor, filters);
      } catch (err) {
        if (err instanceof InvalidCursorError) throw new ApiError(400, 'invalid_cursor');
        throw err;
      }
    }
    const { rows, next } = await listPublicComments(
      this.#pool,
      req.apiKey.organizationId,
      { status: q.status, brandId: q.brandId, postedFrom, postedTo },
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
