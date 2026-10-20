import { describe, expect, it } from 'vitest';
import type { ApiKeyRow } from '@feedbouncer/public-api';
import { CreateApiKeyBody, toApiKeyDto } from './dto.js';

const row: ApiKeyRow & { secretSha256: Buffer; token: string } = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  name: 'CI',
  publicId: 'abcdefghijklmnop',
  scope: 'read',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  createdByUserId: '00000000-0000-4000-8000-000000000003',
  createdByName: 'Ada',
  lastUsedAt: null,
  revokedAt: null,
  secretSha256: Buffer.from('x'),
  token: 'fbk_secret',
};

describe('api key dto', () => {
  it('never includes the hash or a token, and prefixes the public id', () => {
    const dto = toApiKeyDto(row);
    expect(dto).toEqual({
      id: row.id,
      name: 'CI',
      prefix: 'fbk_abcdefghijklmnop',
      scope: 'read',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: { name: 'Ada' },
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(dto)).not.toMatch(/secret|token|organizationId/i);
  });

  it('reports revoked keys and keys without a creator', () => {
    const at = new Date('2026-02-01T00:00:00Z');
    expect(
      toApiKeyDto({ ...row, revokedAt: at, createdByName: null, lastUsedAt: at }),
    ).toMatchObject({
      status: 'revoked',
      revokedAt: at.toISOString(),
      lastUsedAt: at.toISOString(),
      createdBy: null,
    });
  });

  it('create body is strict, trimmed and bounded', () => {
    expect(CreateApiKeyBody.safeParse({ name: ' CI ', scope: 'write' }).data?.name).toBe('CI');
    expect(CreateApiKeyBody.safeParse({ name: 'CI', scope: 'moderate' }).success).toBe(true);
    for (const bad of [
      { name: '', scope: 'read' },
      { name: 'x'.repeat(101), scope: 'read' },
      { name: 'x', scope: 'admin' },
      { name: 'x', scope: 'read', extra: 1 },
    ]) {
      expect(CreateApiKeyBody.safeParse(bad).success).toBe(false);
    }
  });
});
