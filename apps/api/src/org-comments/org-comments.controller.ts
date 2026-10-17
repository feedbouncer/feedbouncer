import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { COMMENT_STATUSES, LISTABLE_PLATFORMS } from '@feedbouncer/actions';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { OrgCommentsService } from './org-comments.service.js';

// The organization comes only from the path. Well-formed but stale or foreign values are
// dropped by the service; malformed ones are rejected here.
const ListQuery = z
  .strictObject({
    platform: z.enum(LISTABLE_PLATFORMS).optional(),
    ad: z.union([zUuid, z.literal('none')]).optional(),
    category: z.union([z.literal('_none'), z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)]).optional(),
    status: z.enum(COMMENT_STATUSES).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: zUuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => (q.before === undefined) === (q.beforeId === undefined));

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
}
