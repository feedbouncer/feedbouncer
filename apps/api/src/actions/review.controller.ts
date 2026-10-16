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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { isClientRequestKey } from '@feedbouncer/comments';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ActionsService } from './actions.service.js';

const ListQuery = z.strictObject({
  status: z.enum(['open', 'resolved']),
  before: zUuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ResolveBody = z.strictObject({
  resolution: z.enum(['approve', 'hide', 'delete', 'ban']),
  requestKey: z.string().refine(isClientRequestKey),
  confirm: z.literal(true).optional(),
});

@Controller('api/v1/orgs/:orgId/brands/:brandId/review-items')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ReviewController {
  constructor(@Inject(ActionsService) private readonly actions: ActionsService) {}

  @Get()
  @RequireCapability('comment.moderate')
  list(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Query() query: unknown) {
    return this.actions.reviewItems(req.org, brandId, parseBody(ListQuery, query));
  }

  @Post(':itemId/resolve')
  @HttpCode(200)
  @RequireCapability('comment.moderate')
  resolve(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    return this.actions.resolve(
      req.org,
      brandId,
      parseUuidOr404(itemId),
      parseBody(ResolveBody, body),
    );
  }
}
