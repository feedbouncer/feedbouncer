import { Inject, Injectable } from '@nestjs/common';
import { MAX_CHECK_TEXT_UNITS, validateCheckText } from '@feedbouncer/moderation-check';
import { ModerationCheckRequest, type ApiKeyContext } from '@feedbouncer/public-api';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { parseBody } from '../http/validation.js';
import { requireBrand, soleActiveBrand } from '../tenancy/brand-scope.js';
import { DEPS, MODERATION_CHECK_CLIENT } from '../tokens.js';
import type { ModerationCheckClient } from './moderation-check.client.js';

const TEXT_PROBLEMS = {
  malformed: 'Text must be well-formed Unicode without U+0000.',
  empty: 'Text has no visible characters.',
} as const;

const unavailable = () =>
  new ApiError(503, 'temporarily_unavailable', undefined, undefined, { 'retry-after': '5' });

@Injectable()
export class ModerationCheckService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(MODERATION_CHECK_CLIENT) private readonly client: ModerationCheckClient,
  ) {}

  async check(key: ApiKeyContext, rawBody: unknown): Promise<unknown> {
    const { text, brandId: rawBrandId, ref } = parseBody(ModerationCheckRequest, rawBody);
    const valid = validateCheckText(text);
    if (!valid.ok) {
      if (valid.problem === 'too_long') {
        throw new ApiError(
          422,
          'text_too_long',
          'Text exceeds 4,000 characters (UTF-16 code units).',
          { maxLength: MAX_CHECK_TEXT_UNITS },
        );
      }
      throw new ApiError(400, 'invalid_request', TEXT_PROBLEMS[valid.problem], {
        field: 'text',
        problem: valid.problem,
      });
    }
    const brandId = await this.#brand(key.organizationId, rawBrandId);
    const timeout = this.deps.env.moderationCheckTimeoutMs;
    const r = await this.client.run(
      {
        v: 1,
        organizationId: key.organizationId,
        brandId,
        text,
        deadlineAt: Date.now() + timeout,
      },
      timeout,
    );
    if (r === 'unavailable') throw unavailable();
    if (r === 'failed') throw new ApiError(500, 'internal_error');
    switch (r.kind) {
      case 'done':
        return { ...r.result, brandId, ref: ref ?? null, checkedAt: new Date().toISOString() };
      case 'brand_gone':
        throw notFound();
      default:
        throw unavailable();
    }
  }

  async #brand(organizationId: string, brandId: string | undefined): Promise<string> {
    const { pool } = this.deps;
    if (brandId !== undefined)
      return (await requireBrand(pool, { organizationId }, brandId)).brandId;
    const sole = await soleActiveBrand(pool, organizationId);
    if (sole === null) {
      throw new ApiError(
        400,
        'invalid_request',
        'brandId is required when the workspace has more or fewer than one active brand.',
        { field: 'brandId', problem: 'required' },
      );
    }
    return sole;
  }
}
