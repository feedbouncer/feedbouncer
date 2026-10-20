import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { PgApiKeys } from '@feedbouncer/public-api';
import { notFound } from '../http/errors.js';
import { API_KEYS } from '../tokens.js';
import { ApiKeyGuard, type ApiKeyRequest } from './api-key.guard.js';
import { RequireScope } from './scope.decorator.js';

@Controller('v1/key')
@UseGuards(ApiKeyGuard)
export class PublicKeyController {
  constructor(@Inject(API_KEYS) private readonly keys: PgApiKeys) {}

  /** Never the public id or the secret: the caller already holds the key. */
  @Get()
  @RequireScope('moderate')
  async get(@Req() req: ApiKeyRequest) {
    const { organizationId, apiKeyId } = req.apiKey;
    const key = await this.keys.get(organizationId, apiKeyId);
    if (!key) throw notFound();
    return { organizationId, name: key.name, scope: key.scope };
  }
}
