import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import type { Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { createMemoryStack } from './testing/runtime.js';
import type { RecentSource } from './types.js';

const since = new Date('2026-09-14T00:00:00Z');

function connector(over: Partial<Connector> = {}): Connector {
  return {
    platform: 'facebook',
    capabilities: {
      actions: ['hide'],
      listSources: false,
      recentSources: false,
      ingestion: 'polling',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      rateLimit: {
        points: 100,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 5_000,
      },
      apiHosts: ['api.example.test'],
      authorizationHosts: ['auth.example.test'],
      defaultScopes: ['s'],
      maxPageSize: 50,
    },
    buildAuthorizationUrl: ({ state }) => new URL(`https://auth.example.test/a?state=${state}`),
    exchangeCode: async () => {
      throw new Error('unused');
    },
    refreshTokens: async () => {
      throw new Error('unused');
    },
    listComments: async () => ({ items: [], nextCursor: null }),
    getComment: async () => null,
    act: async () => ({ status: 'applied', platformActionId: null }),
    ...over,
  };
}

function withRecent(items: RecentSource[]) {
  const listRecentSources = vi.fn(
    async (_ctx: unknown, _req: { since: Date; cursor: string | null; limit: number }) => ({
      items,
      nextCursor: null,
    }),
  );
  const base = connector();
  const c: Connector = {
    ...base,
    capabilities: { ...base.capabilities, recentSources: true },
    listRecentSources,
  };
  return { c, listRecentSources };
}

async function connected(c: Connector) {
  const stack = await createMemoryStack(c, {
    webhookSecret: null,
    redirectUri: 'https://app.test/cb',
  });
  const { scope } = await stack.directory.upsertPending({
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    platform: 'facebook',
    externalAccountId: '900',
    displayName: null,
    grantedScopes: [],
  });
  await stack.vault.writeAccessToken(scope, { value: new Secret('PAGE-TOKEN'), expiresAt: null });
  await stack.directory.activate(scope, stack.actor.userId);
  return { stack, scope };
}

describe('ConnectionClient.listRecentSources', () => {
  it('throws unsupported without I/O when the connector has no listRecentSources', async () => {
    const { stack, scope } = await connected(connector());
    const acquire = vi.spyOn(stack.budget, 'acquire');
    const client = await stack.runtime.connect(scope);
    await expect(client.listRecentSources({ since, cursor: null })).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'list_recent_sources',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects an invalid cursor or since before any I/O', async () => {
    const { c, listRecentSources } = withRecent([]);
    const { stack, scope } = await connected(c);
    const acquire = vi.spyOn(stack.budget, 'acquire');
    const client = await stack.runtime.connect(scope);
    await expect(
      client.listRecentSources({ since, cursor: 'x'.repeat(2049) }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      client.listRecentSources({ since: new Date(NaN), cursor: null }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(acquire).not.toHaveBeenCalled();
    expect(listRecentSources).not.toHaveBeenCalled();
  });

  it('runs at the requested priority, clamps the limit, and parses items', async () => {
    const { c, listRecentSources } = withRecent([
      { externalId: '111_222', createdAt: new Date('2026-10-01T00:00:00Z'), permalink: null },
    ]);
    const { stack, scope } = await connected(c);
    const acquire = vi.spyOn(stack.budget, 'acquire');
    const client = await stack.runtime.connect(scope);
    const page = await client.listRecentSources(
      { since, cursor: null, limit: 10_000 },
      { priority: 'background' },
    );
    expect(acquire).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'background',
    );
    expect(listRecentSources.mock.calls[0]?.[1].limit).toBe(client.capabilities.maxPageSize);
    expect(page.items.map((s) => s.externalId)).toEqual(['111_222']);
  });

  it('rejects a connector item with an unsafe id', async () => {
    const { c } = withRecent([{ externalId: '', createdAt: new Date(), permalink: null }]);
    const { stack, scope } = await connected(c);
    const client = await stack.runtime.connect(scope);
    await expect(client.listRecentSources({ since, cursor: null })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
