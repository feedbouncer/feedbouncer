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
import {
  BULK_MAX,
  CATEGORY_SLUG,
  COMMENT_STATUSES,
  LISTABLE_PLATFORMS,
  QUEUES,
  TAG_IDS_MAX,
} from '@feedbouncer/actions';
import { isClientRequestKey } from '@feedbouncer/comments';
import { replyTextSchema } from '@feedbouncer/connectors';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { OrgCommentsService } from './org-comments.service.js';

const TAGS_PARAM = /^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i;

// Postgres returns lowercase uuids, so tag ids are lowercased at the boundary.
const zTagId = zUuid.transform((id) => id.toLowerCase());

// The organization comes only from the path. Well-formed but stale or foreign values are
// dropped by the service; malformed ones are rejected here.
const ListQuery = z
  .strictObject({
    platform: z.enum(LISTABLE_PLATFORMS).optional(),
    ad: z.union([zUuid, z.literal('none')]).optional(),
    category: z.union([z.literal('_none'), z.string().regex(CATEGORY_SLUG)]).optional(),
    status: z.enum(COMMENT_STATUSES).optional(),
    queue: z.enum(QUEUES).default('open'),
    // Comma-separated tag ids; each must be a UUID.
    tags: z
      .string()
      .regex(TAGS_PARAM)
      .transform((s) => s.split(','))
      .pipe(z.array(zTagId).max(TAG_IDS_MAX))
      .optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: zUuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => (q.before === undefined) === (q.beforeId === undefined));

export type ListQueryDto = z.infer<typeof ListQuery>;

const distinct = (ids: readonly string[], ctx: z.RefinementCtx) => {
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate' });
};

const TagIds = z.array(zTagId).min(1).max(TAG_IDS_MAX).superRefine(distinct);

const TriageBody = z.strictObject({
  commentIds: z.array(zUuid).min(1).max(BULK_MAX).superRefine(distinct),
  op: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('done') }),
    z.strictObject({ type: z.literal('reopen') }),
    z.strictObject({ type: z.literal('add_tags'), tagIds: TagIds }),
    z.strictObject({ type: z.literal('remove_tags'), tagIds: TagIds }),
  ]),
});

const ReplyBody = z.strictObject({
  requestKey: z.string().refine(isClientRequestKey),
  text: replyTextSchema,
});

@Controller('api/v1/orgs/:orgId/comments')
@UseGuards(SessionGuard, OrgAccessGuard)
export class OrgCommentsController {
  constructor(@Inject(OrgCommentsService) private readonly comments: OrgCommentsService) {}

  @Get()
  @RequireCapability('comment.read')
  list(@Req() req: OrgRequest, @Query() query: unknown) {
    return this.comments.list(req.org, parseBody(ListQuery, query));
  }

  @Get('filters')
  @RequireCapability('comment.read')
  filters(@Req() req: OrgRequest) {
    return this.comments.filters(req.org);
  }

  @Post('triage')
  @HttpCode(200)
  @RequireCapability('comment.triage')
  triage(@Req() req: OrgRequest, @Body() body: unknown) {
    const b = parseBody(TriageBody, body);
    return this.comments.triage(req.org, b.commentIds, b.op);
  }

  @Get(':commentId/replies')
  @RequireCapability('comment.read')
  async replies(@Req() req: OrgRequest, @Param('commentId') commentId: string) {
    return { replies: await this.comments.replies(req.org, parseUuidOr404(commentId)) };
  }

  // The route guard checks comment.reply with the member's grants, so a revoked grant is a 403.
  @Post(':commentId/replies')
  @RequireCapability('comment.reply')
  async reply(
    @Req() req: OrgRequest,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const id = parseUuidOr404(commentId);
    const r = await this.comments.reply(req.org, id, parseBody(ReplyBody, body));
    void res.status(r.status);
    return { reply: r.reply };
  }
}
