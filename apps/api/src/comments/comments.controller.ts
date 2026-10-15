import {
  Body,
  Controller,
  Get,
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
import { ACTION_KINDS, REPLY_KINDS, REQUEST_KEY } from '@feedbouncer/comments';
import { replyTextSchema } from '@feedbouncer/connectors';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { CommentsService } from './comments.service.js';

const ListQuery = z.strictObject({
  before: z.iso.datetime({ offset: true }).optional(),
  beforeId: zUuid.optional(),
  connectionId: zUuid.optional(),
  origin: z.enum(['ad', 'organic']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ActionBody = z
  .strictObject({
    kind: z.enum(ACTION_KINDS),
    requestKey: z.string().regex(REQUEST_KEY),
    text: replyTextSchema.optional(),
  })
  .refine((b) => REPLY_KINDS.has(b.kind) === (b.text !== undefined), { path: ['text'] });

@Controller('api/v1/orgs/:orgId/brands/:brandId/comments')
@UseGuards(SessionGuard, OrgAccessGuard)
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly svc: CommentsService) {}

  @Get()
  @RequireCapability('comment.moderate')
  async list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    const q = parseBody(ListQuery, query);
    const comments = await this.svc.list(req.org, brandId, {
      limit: q.limit,
      ...(q.before !== undefined && { before: new Date(q.before) }),
      ...(q.beforeId !== undefined && { beforeId: q.beforeId }),
      ...(q.connectionId !== undefined && { connectionId: q.connectionId }),
      ...(q.origin !== undefined && { origin: q.origin }),
    });
    return { comments };
  }

  @Get(':commentId/actions')
  @RequireCapability('comment.moderate')
  async actions(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('commentId') commentId: string,
  ) {
    return { actions: await this.svc.actions(req.org, brandId, parseUuidOr404(commentId)) };
  }

  @Get(':commentId/decisions')
  @RequireCapability('comment.moderate')
  async decisions(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('commentId') commentId: string,
  ) {
    return { decisions: await this.svc.decisions(req.org, brandId, parseUuidOr404(commentId)) };
  }

  @Get(':commentId/classification')
  @RequireCapability('comment.moderate')
  async classification(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('commentId') commentId: string,
  ) {
    return {
      classification: await this.svc.classification(req.org, brandId, parseUuidOr404(commentId)),
    };
  }

  @Get(':commentId/policy-evaluation')
  @RequireCapability('comment.moderate')
  policyEvaluation(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('commentId') commentId: string,
  ) {
    return this.svc.policyEvaluation(req.org, brandId, parseUuidOr404(commentId));
  }

  @Post(':commentId/actions')
  @RequireCapability('comment.moderate')
  async request(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = parseUuidOr404(commentId);
    const r = await this.svc.request(req.org, brandId, id, parseBody(ActionBody, body));
    void reply.status(r.status);
    return { action: r.action };
  }
}
