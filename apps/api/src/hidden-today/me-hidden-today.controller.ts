import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { parseBody, zUuid } from '../http/validation.js';
import { HiddenTodayService } from './hidden-today.service.js';

// No organization or brand ids: the organizations come from the caller's memberships.
const ListQuery = z
  .strictObject({
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: zUuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => (q.before === undefined) === (q.beforeId === undefined));

@Controller('api/v1/me/hidden-today')
@UseGuards(SessionGuard)
export class MeHiddenTodayController {
  constructor(@Inject(HiddenTodayService) private readonly hidden: HiddenTodayService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: unknown) {
    const { before, beforeId, limit } = parseBody(ListQuery, query);
    return this.hidden.list(req.user.id, {
      limit,
      before: before && beforeId ? { hiddenAt: new Date(before), hideActionId: beforeId } : null,
    });
  }
}
