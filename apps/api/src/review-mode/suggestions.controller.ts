import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { GATED_STEP_TYPES, SUGGESTION_STATUSES } from '@feedbouncer/actions';
import { isClientRequestKey } from '@feedbouncer/comments';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ReviewModeService } from './review-mode.service.js';

const zRequestKey = z.string().refine(isClientRequestKey);
const zAction = z.enum(['approve', 'dismiss']);

const ListQuery = z.strictObject({
  status: z.enum([...SUGGESTION_STATUSES, 'all']).optional(),
  connectionId: zUuid.optional(),
  ruleId: zUuid.optional(),
  authorId: zUuid.optional(),
  stepType: z.enum(GATED_STEP_TYPES).optional(),
  before: zUuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const AuthorsQuery = z.strictObject({
  connectionId: zUuid,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ApproveBody = z.strictObject({
  requestKey: zRequestKey,
  confirm: z.literal(true).optional(),
});

const DismissBody = z.strictObject({ requestKey: zRequestKey });

const BulkBody = z.union([
  z.strictObject({
    action: zAction,
    ids: z.array(zUuid).min(1).max(100),
    requestKey: zRequestKey,
    confirm: z.literal(true).optional(),
  }),
  z.strictObject({
    action: zAction,
    connectionId: zUuid,
    filter: z.strictObject({
      ruleId: zUuid.optional(),
      authorId: zUuid.optional(),
      stepType: z.enum(GATED_STEP_TYPES).optional(),
    }),
    requestKey: zRequestKey,
    confirm: z.literal(true).optional(),
  }),
]);

@Controller('api/v1/orgs/:orgId/brands/:brandId/suggestions')
@UseGuards(SessionGuard, OrgAccessGuard)
export class SuggestionsController {
  constructor(@Inject(ReviewModeService) private readonly svc: ReviewModeService) {}

  @Get()
  @RequireCapability('comment.moderate')
  list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    return this.svc.list(req.org, brandId, parseBody(ListQuery, query));
  }

  @Get('authors')
  @RequireCapability('comment.moderate')
  authors(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    return this.svc.authors(req.org, brandId, parseBody(AuthorsQuery, query));
  }

  @Post('bulk')
  @RequireCapability('comment.moderate')
  async bulk(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.svc.bulk(req.org, brandId, parseBody(BulkBody, body));
    if (r.kind === 'filter') {
      void reply.status(202);
      return { matched: r.matched };
    }
    void reply.status(200);
    return { results: r.results };
  }

  @Post(':suggestionId/approve')
  @HttpCode(200)
  @RequireCapability('comment.moderate')
  approve(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ) {
    return this.svc.approve(
      req.org,
      brandId,
      parseUuidOr404(suggestionId),
      parseBody(ApproveBody, body),
    );
  }

  @Post(':suggestionId/dismiss')
  @HttpCode(200)
  @RequireCapability('comment.moderate')
  dismiss(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ) {
    return this.svc.dismiss(
      req.org,
      brandId,
      parseUuidOr404(suggestionId),
      parseBody(DismissBody, body),
    );
  }
}
