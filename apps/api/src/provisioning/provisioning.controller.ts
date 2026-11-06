import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { recordProvisioningAudit, type ProvisioningAuditInput } from '@feedbouncer/db';
import { errorFields } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { parseUuidOr404, zUuid } from '../http/validation.js';
import { DEPS } from '../tokens.js';
import { CreateOrganizationBody, CreateUserBody } from './dto.js';
import { ProvisioningGuard, type ProvisioningRequest } from './provisioning.guard.js';
import { ProvisioningService } from './provisioning.service.js';
import { parseProvisioningBody } from './validation.js';

const OUTCOMES: Readonly<Record<number, ProvisioningAuditInput['outcome']>> = {
  400: 'invalid',
  404: 'not_found',
  409: 'conflict',
};

@Controller('provisioning/v1')
@UseGuards(ProvisioningGuard)
export class ProvisioningController {
  constructor(
    @Inject(ProvisioningService) private readonly service: ProvisioningService,
    @Inject(DEPS) private readonly deps: AppDeps,
  ) {}

  /** 201 when created, 200 when replayed. */
  @Post('organizations')
  async createOrganization(
    @Req() req: ProvisioningRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const fp = req.provisioning.credentialFingerprint;
    const result = await this.audited(fp, 'organization.create', 'organization', null, () =>
      this.service.createOrganization(fp, parseProvisioningBody(CreateOrganizationBody, body)),
    );
    void reply.status(result.replayed ? 200 : 201);
    return result;
  }

  @Get('organizations/:organizationId')
  getOrganization(@Req() req: ProvisioningRequest, @Param('organizationId') raw: string) {
    const fp = req.provisioning.credentialFingerprint;
    return this.audited(fp, 'organization.read', 'organization', uuidOrNull(raw), async () => ({
      organization: await this.service.getOrganization(fp, parseUuidOr404(raw)),
    }));
  }

  /** 201 when created, 200 when replayed. */
  @Post('organizations/:organizationId/users')
  async createUser(
    @Req() req: ProvisioningRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('organizationId') raw: string,
    @Body() body: unknown,
  ) {
    const fp = req.provisioning.credentialFingerprint;
    const result = await this.audited(fp, 'user.create', 'user', null, () =>
      this.service.createUser(fp, parseUuidOr404(raw), parseProvisioningBody(CreateUserBody, body)),
    );
    void reply.status(result.replayed ? 200 : 201);
    return result;
  }

  @Get('users/:userId')
  getUser(@Req() req: ProvisioningRequest, @Param('userId') raw: string) {
    const fp = req.provisioning.credentialFingerprint;
    return this.audited(fp, 'user.read', 'user', uuidOrNull(raw), async () => ({
      user: await this.service.getUser(fp, parseUuidOr404(raw)),
    }));
  }

  /**
   * Runs an operation and audits its failure, with the error code and field names
   * only, in a statement of its own; then rethrows. Successes are audited by the service.
   */
  private async audited<T>(
    fp: string,
    action: ProvisioningAuditInput['action'],
    targetType: 'organization' | 'user',
    targetId: string | null,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(500, 'internal_error');
      const fields = [...new Set(e.details?.issues?.map((i) => i.path) ?? [])].join(',');
      await recordProvisioningAudit(this.deps.pool, {
        action,
        targetType,
        targetId,
        outcome: OUTCOMES[e.status] ?? 'failed',
        credentialFingerprint: fp,
        details: { errorCode: e.code, ...(fields && { fields }) },
      }).catch((auditErr: unknown) =>
        this.deps.log.error('provisioning.audit_failed', { action, ...errorFields(auditErr) }),
      );
      throw err;
    }
  }
}

const uuidOrNull = (raw: string): string | null => zUuid.safeParse(raw).data ?? null;
