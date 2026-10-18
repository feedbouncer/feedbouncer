import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import type pg from 'pg';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  ListFlaggedItemsQuery,
  listPublicFlaggedItems,
  loadPublicFlaggedItem,
  toCommentResource,
  toFlaggedItemResource,
} from '@feedbouncer/public-api';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/flagged-items')
@UseGuards(ApiKeyGuard)
export class PublicFlaggedItemsController {
  readonly #pool: pg.Pool;

  constructor(@Inject(DEPS) deps: AppDeps) {
    this.#pool = deps.pool;
  }

  @Get()
  @RequireScope('read')
  async list(@Req() req: ApiKeyRequest, @Query() rawQuery: unknown) {
    const q = parseBody(ListFlaggedItemsQuery, rawQuery);
    const createdFrom = q.createdFrom ? new Date(q.createdFrom) : undefined;
    const createdTo = q.createdTo ? new Date(q.createdTo) : undefined;
    if (createdFrom && createdTo && createdFrom >= createdTo) {
      throw new ApiError(400, 'invalid_request', 'createdFrom must be before createdTo.');
    }
    const filters = {
      status: q.status,
      brandId: q.brandId,
      createdFrom: q.createdFrom,
      createdTo: q.createdTo,
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
    const { rows, next } = await listPublicFlaggedItems(
      this.#pool,
      req.apiKey.organizationId,
      { status: q.status, brandId: q.brandId, createdFrom, createdTo },
      { limit: q.limit, after },
    );
    return {
      data: rows.map((r) =>
        toFlaggedItemResource(r, r.comment ? toCommentResource(r.comment) : null),
      ),
      nextCursor: next && encodeCursor(next, filters),
    };
  }

  @Get(':id')
  @RequireScope('read')
  async get(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const found = await loadPublicFlaggedItem(
      this.#pool,
      req.apiKey.organizationId,
      parseUuidOr404(id),
    );
    if (!found) throw notFound();
    return toFlaggedItemResource(found.item, found.comment && toCommentResource(found.comment));
  }
}
