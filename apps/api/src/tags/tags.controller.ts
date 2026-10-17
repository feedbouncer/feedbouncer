import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { TagsService } from './tags.service.js';

// The name's own rules (trim, 1-50 code points, no control characters) are checked by the
// service so a refusal can say which rule failed; this only bounds the input.
const CreateTag = z.strictObject({ name: z.string().max(400) });
const DeleteTag = z.strictObject({ confirmCount: z.number().int().min(0) });

@Controller('api/v1/orgs/:orgId/tags')
@UseGuards(SessionGuard, OrgAccessGuard)
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Get()
  @RequireCapability('comment.read')
  async list(@Req() req: OrgRequest) {
    return this.tags.list(req.org);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('comment.triage')
  async create(@Req() req: OrgRequest, @Body() body: unknown) {
    return { tag: await this.tags.create(req.org, parseBody(CreateTag, body).name) };
  }

  @Delete(':tagId')
  @HttpCode(200)
  @RequireCapability('tag.manage')
  remove(@Req() req: OrgRequest, @Param('tagId') tagId: string, @Body() body: unknown) {
    const id = parseUuidOr404(tagId);
    return this.tags.remove(req.org, id, parseBody(DeleteTag, body).confirmCount);
  }
}
