import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import type { Connector } from './connector.js';
import { createMemoryStack } from './testing/runtime.js';

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

describe('ConnectionClient.verifySourceOwner', () => {
  it('throws unsupported without I/O when the connector cannot check owners', async () => {
    const { stack, scope } = await connected(connector());
    const acquire = vi.spyOn(stack.budget, 'acquire');
    const client = await stack.runtime.connect(scope);
    await expect(client.verifySourceOwner('111')).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'verify_source_owner',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects an invalid source id before any I/O', async () => {
    const verifySourceOwner = vi.fn(async () => true);
    const { stack, scope } = await connected(connector({ verifySourceOwner }));
    const client = await stack.runtime.connect(scope);
    await expect(client.verifySourceOwner('bad\nid')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(verifySourceOwner).not.toHaveBeenCalled();
  });

  it('asks the connector at background priority and returns its answer', async () => {
    const verifySourceOwner = vi.fn(async (_ctx: unknown, id: string) => id === '111');
    const { stack, scope } = await connected(connector({ verifySourceOwner }));
    const acquire = vi.spyOn(stack.budget, 'acquire');
    const client = await stack.runtime.connect(scope);
    expect(await client.verifySourceOwner('111')).toBe(true);
    expect(await client.verifySourceOwner('222')).toBe(false);
    expect(acquire.mock.calls.at(-1)?.[3]).toBe('background');
  });
});
