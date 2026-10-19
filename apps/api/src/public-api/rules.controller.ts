import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ListRulesQuery,
  PgIdempotency,
  ProposeRuleChangeBody,
  routeSpec,
} from '@feedbouncer/public-api';
import { parseBody } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import type { AppDeps } from '../deps.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { runIdempotent } from './idempotent.js';
import { PublicRuleProposalsService } from './rule-proposals.service.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1')
@UseGuards(ApiKeyGuard)
export class PublicRulesController {
  readonly #idempotency: PgIdempotency;

  constructor(
    @Inject(DEPS) deps: AppDeps,
    @Inject(PublicRuleProposalsService) private readonly proposals: PublicRuleProposalsService,
  ) {
    this.#idempotency = new PgIdempotency(deps.pool);
  }

  @Get('rules')
  @RequireScope('read')
  list(@Req() req: ApiKeyRequest, @Query() rawQuery: unknown) {
    const q = parseBody(ListRulesQuery, rawQuery);
    return this.proposals.ruleSet(req.apiKey, q.brandId);
  }

  @Post('rule-change-proposals')
  @RequireScope('write')
  propose(
    @Req() req: ApiKeyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() rawBody: unknown,
  ) {
    const body = parseBody(ProposeRuleChangeBody, rawBody);
    return runIdempotent(
      this.#idempotency,
      req,
      reply,
      routeSpec('proposeRuleChange'),
      {},
      body,
      (idempotencyKey) => this.proposals.propose(req.apiKey, body, idempotencyKey),
    );
  }
}
