import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { parseBody, parseUuidOr404, zName, zTimeZone } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { BrandsService } from './brands.service.js';

const CreateBody = z.strictObject({ name: zName, timezone: zTimeZone.optional().catch(undefined) });
const PatchBody = z
  .strictObject({ name: zName.optional(), timezone: zTimeZone.optional() })
  .refine((b) => b.name !== undefined || b.timezone !== undefined);
const ListQuery = z.strictObject({ includeArchived: z.enum(['true', 'false']).optional() });

@Controller('api/v1/orgs/:orgId/brands')
@UseGuards(SessionGuard, OrgAccessGuard)
export class BrandsController {
  constructor(@Inject(BrandsService) private readonly brands: BrandsService) {}

  @Get()
  @RequireCapability('brand.read')
  async list(@Req() req: OrgRequest, @Query() query: unknown) {
    const { includeArchived } = parseBody(ListQuery, query);
    return { brands: await this.brands.list(req.org, includeArchived === 'true') };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('brand.write')
  async create(@Req() req: OrgRequest, @Body() body: unknown) {
    const { name, timezone } = parseBody(CreateBody, body);
    return { brand: await this.brands.create(req.org, name, timezone) };
  }

  @Get(':brandId')
  @RequireCapability('brand.read')
  async get(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { brand: await this.brands.get(req.org, parseUuidOr404(brandId)) };
  }

  @Patch(':brandId')
  @RequireCapability('brand.write')
  async update(@Req() req: OrgRequest, @Param('brandId') brandId: string, @Body() body: unknown) {
    const patch = parseBody(PatchBody, body);
    return { brand: await this.brands.update(req.org, parseUuidOr404(brandId), patch) };
  }

  @Post(':brandId/archive')
  @HttpCode(200)
  @RequireCapability('brand.write')
  async archive(@Req() req: OrgRequest, @Param('brandId') brandId: string) {
    return { brand: await this.brands.archive(req.org, parseUuidOr404(brandId)) };
  }
}
