import { z } from 'zod';
import type { ApiKeyRow, ApiKeyScope } from '@feedbouncer/public-api';

export const CreateApiKeyBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['read', 'write']),
});

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyScope;
  status: 'active' | 'revoked';
  createdAt: string;
  createdBy: { name: string } | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The key as the dashboard shows it: the public id only, never the hash or the token. */
export function toApiKeyDto(k: ApiKeyRow): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: `fbk_${k.publicId}`,
    scope: k.scope,
    status: k.revokedAt ? 'revoked' : 'active',
    createdAt: k.createdAt.toISOString(),
    createdBy: k.createdByName === null ? null : { name: k.createdByName },
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}
