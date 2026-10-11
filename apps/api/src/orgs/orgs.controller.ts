import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { MembersService } from '../members/members.service.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { ROLES } from '@feedbouncer/authz';
import { parseBody, zName, zUuid } from '../http/validation.js';
import { RequireCapability } from '../tenancy/capability.decorator.js';
import { OrgAccessGuard, type OrgRequest } from '../tenancy/org-access.guard.js';
import { OrgsService } from './orgs.service.js';

const CreateOrg = z.strictObject({ name: zName, brandName: zName.optional() });
const RenameOrg = z.strictObject({ name: zName });
const TransferOwnership = z.strictObject({ userId: zUuid, newRoleForSelf: z.enum(ROLES) });
const DeleteOrg = z.strictObject({ confirmName: z.string().max(400) });

@Controller('api/v1/orgs')
@UseGuards(SessionGuard)
export class OrgsListController {
  constructor(@Inject(OrgsService) private readonly orgs: OrgsService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return { organizations: await this.orgs.listMine(req.user.id) };
  }

  @Post()
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.orgs.create(req.user, parseBody(CreateOrg, body));
  }
}

@Controller('api/v1/orgs/:orgId')
@UseGuards(SessionGuard, OrgAccessGuard)
export class OrgController {
  constructor(
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  @Get()
  @RequireCapability('org.read')
  get(@Req() req: OrgRequest) {
    return this.orgs.get(req.org);
  }

  @Patch()
  @RequireCapability('org.update')
  async rename(@Req() req: OrgRequest, @Body() body: unknown) {
    return { organization: await this.orgs.rename(req.org, parseBody(RenameOrg, body).name) };
  }

  @Delete()
  @HttpCode(204)
  @RequireCapability('org.delete')
  async remove(@Req() req: OrgRequest, @Body() body: unknown) {
    await this.orgs.remove(req.org, parseBody(DeleteOrg, body).confirmName);
  }

  @Post('transfer-ownership')
  @HttpCode(200)
  @RequireCapability('org.transfer_ownership')
  async transferOwnership(@Req() req: OrgRequest, @Body() body: unknown) {
    const { userId, newRoleForSelf } = parseBody(TransferOwnership, body);
    await this.members.transferOwnership(req.org, userId, newRoleForSelf);
    return { status: 'ok' };
  }
}
