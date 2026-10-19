import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import { computePeriodSummary, resolveSummaryRange } from '@feedbouncer/reports';
import { GetSummaryQuery } from '@feedbouncer/public-api';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/summary')
@UseGuards(ApiKeyGuard)
export class PublicSummaryController {
  readonly #pool: pg.Pool;

  constructor(@Inject(DEPS) deps: AppDeps) {
    this.#pool = deps.pool;
  }

  @Get()
  @RequireScope('read')
  async summary(@Req() req: ApiKeyRequest, @Query() rawQuery: unknown) {
    const q = parseBody(GetSummaryQuery, rawQuery);
    const range = resolveRange(q);
    const orgId = req.apiKey.organizationId;
    // One read-only snapshot, so every number agrees.
    const summary = await withTransaction(
      this.#pool,
      async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        if (q.brandId) {
          const brand = await c.query(
            'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2',
            [orgId, q.brandId],
          );
          if (!brand.rowCount) throw notFound();
        }
        return computePeriodSummary(c, orgId, {
          from: range.from,
          to: range.to,
          brandId: q.brandId,
        });
      },
      { isolation: 'repeatable read' },
    );
    return {
      period: { from: range.from.toISOString(), to: range.to.toISOString() },
      bounded: range.bounded,
      ...summary,
    };
  }
}

function resolveRange(q: { from?: string | undefined; to?: string | undefined }) {
  try {
    return resolveSummaryRange(
      { from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined },
      new Date(),
    );
  } catch (err) {
    if (err instanceof RangeError)
      throw new ApiError(400, 'invalid_request', undefined, { reason: err.message });
    throw err;
  }
}
