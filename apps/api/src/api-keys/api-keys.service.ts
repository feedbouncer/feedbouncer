import { Inject, Injectable } from '@nestjs/common';
import {
  ApiKeyLimitError,
  ApiKeyNameTakenError,
  PgApiKeys,
  type ApiKeyScope,
} from '@feedbouncer/public-api';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { API_KEYS } from '../tokens.js';
import { toApiKeyDto, type ApiKeyDto } from './dto.js';

/** Dashboard key management. The token is returned once, at creation, and never logged. */
@Injectable()
export class ApiKeysService {
  constructor(@Inject(API_KEYS) private readonly keys: PgApiKeys) {}

  async list(org: OrgContext): Promise<{ items: ApiKeyDto[] }> {
    return { items: (await this.keys.list(org.organizationId)).map(toApiKeyDto) };
  }

  async create(
    org: OrgContext,
    input: { name: string; scope: ApiKeyScope },
  ): Promise<{ key: ApiKeyDto; token: string }> {
    try {
      const { key, token } = await this.keys.create(org.organizationId, org.actorUserId, input);
      return { key: toApiKeyDto(key), token: token.reveal() };
    } catch (err) {
      if (err instanceof ApiKeyLimitError) throw new ApiError(409, 'api_key_limit_reached');
      if (err instanceof ApiKeyNameTakenError) throw new ApiError(409, 'api_key_name_taken');
      throw err;
    }
  }

  async revoke(org: OrgContext, keyId: string): Promise<ApiKeyDto> {
    const key = await this.keys.revoke(org.organizationId, org.actorUserId, keyId);
    if (!key) throw notFound();
    return toApiKeyDto(key);
  }
}
