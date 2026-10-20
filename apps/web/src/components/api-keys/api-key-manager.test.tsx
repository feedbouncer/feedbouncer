import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyDto } from '../../lib/api-keys';
import { ApiKeyManager } from './api-key-manager';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const key = (over: Partial<ApiKeyDto>): ApiKeyDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'CI',
  prefix: 'fbk_abcdefghijklmnop',
  scope: 'read',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { name: 'Ada' },
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

const render = (items: ApiKeyDto[]) =>
  renderToStaticMarkup(
    <ApiKeyManager orgId="22222222-2222-4222-8222-222222222222" items={items} />,
  );

describe('ApiKeyManager', () => {
  it('renders the form, the intro and the table columns', () => {
    const html = render([
      key({}),
      key({
        id: 'b1111111-1111-4111-8111-111111111111',
        name: 'Old',
        scope: 'write',
        status: 'revoked',
        lastUsedAt: '2026-01-02T03:04:05.000Z',
        revokedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    expect(html).toContain('Create key');
    expect(html).toContain('Moderate only');
    expect(html).toContain('Read only');
    expect(html).toContain('Read and write');
    for (const h of ['Name', 'Key', 'Access', 'Created', 'Last used', 'Status']) {
      expect(html).toContain(`<th>${h}</th>`);
    }
    expect(html).toContain('fbk_abcdefghijklmnop…');
    expect(html).toContain('Never');
    expect(html).toContain('2026-01-02 03:04 UTC');
    expect(html).toContain('Active');
    expect(html).toContain('Revoked');
    expect(html.match(/>Revoke</g)).toHaveLength(1);
    expect(html).not.toContain('Copy this key now');
  });

  it('renders names as text', () => {
    const html = render([key({ name: '<img src=x onerror=alert(1)>' })]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
