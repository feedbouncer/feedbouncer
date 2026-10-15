import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';
import {
  previewRequestSchema,
  rerunRequestSchema,
  thresholdIssues,
  thresholdUpdateSchema,
} from '@feedbouncer/classifier';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiError } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { ClassifierService } from './classifier.service.js';

function parseSettings<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const input = body ?? {};
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issues = thresholdIssues(r.error, input);
  throw new ApiError(400, 'invalid_classifier_settings', issues[0]?.message, { issues });
}

@Controller('api/v1/orgs/:orgId/brands/:brandId/classifier')
@UseGuards(SessionGuard, OrgAccessGuard)
export class ClassifierController {
  constructor(@Inject(ClassifierService) private readonly svc: ClassifierService) {}

  @Get('settings')
  @RequireCapability('rule.read')
  async settings(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return this.svc.settings(await this.svc.scope(req.org, brandId));
  }

  @Put('settings')
  @RequireCapability('rule.write')
  async update(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    const scope = await this.svc.scope(req.org, brandId);
    const { categories } = parseSettings(thresholdUpdateSchema, body);
    return this.svc.update(req.org, scope, categories);
  }

  @Post('preview')
  @HttpCode(200)
  @RequireCapability('rule.read')
  async preview(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    const scope = await this.svc.scope(req.org, brandId);
    const { categories, days } = parseSettings(previewRequestSchema, body);
    return this.svc.preview(scope, categories, days);
  }

  @Post('reruns')
  @HttpCode(202)
  @RequireCapability('rule.write')
  async rerun(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    const scope = await this.svc.scope(req.org, brandId);
    const { days } = parseSettings(rerunRequestSchema, body);
    return this.svc.rerun(req.org, scope, days);
  }

  @Get('reruns/:runId')
  @RequireCapability('rule.read')
  async run(
    @Req() req: OrgRequest,
    @Param('brandId') brandId: string,
    @Param('runId') runId: string,
  ) {
    const scope = await this.svc.scope(req.org, brandId);
    return this.svc.run(scope, parseUuidOr404(runId));
  }
}
