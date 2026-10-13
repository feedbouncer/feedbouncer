import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import type { Connector } from './connector.js';
import { ConnectorError } from './errors.js';
import { createMemoryStack } from './testing/runtime.js';
import { ConnectorRuntime } from './runtime.js';

function connector(over: Partial<Connector> = {}): Connector {
  return {
    platform: 'facebook',
    capabilities: {
      actions: ['hide'],
      listSources: false,
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
      responses: ['public_reply', 'private_reply'],
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
    respond: async () => ({ status: 'sent', platformRef: '123_456' }),
    lifecycle: { onConnected: vi.fn(async () => {}), onDisconnected: vi.fn(async () => {}) },
    ...over,
  };
}

function withoutLifecycle(): Connector {
  const c: { -readonly [K in keyof Connector]: Connector[K] } = connector();
  delete c.lifecycle;
  return c;
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
const target = { sourceExternalId: '900_1', externalId: '900_1_2' };

describe('ConnectionClient.respond', () => {
  it('returns sent with a validated platform ref', async () => {
    const { stack, scope } = await connected(connector());
    const client = await stack.runtime.connect(scope);
    expect(await client.respond({ kind: 'public_reply', target, text: ' hi ' })).toEqual({
      status: 'sent',
      request: { kind: 'public_reply', target, text: 'hi' },
      platformRef: '123_456',
    });
  });

  it('maps not_eligible, not_found, unsupported and failures without throwing', async () => {
    const cases: [NonNullable<Connector['respond']>, string][] = [
      [async () => ({ status: 'not_eligible', code: 'window_closed' }), 'not_eligible'],
      [async () => ({ status: 'not_found' }), 'not_found'],
      [
        async () => {
          throw new ConnectorError('not_found', 'object_missing');
        },
        'not_found',
      ],
      [
        async () => {
          throw new ConnectorError('permanent', 'permission_denied');
        },
        'failed',
      ],
      [async () => ({ status: 'not_eligible', code: 'Bad Code!' }) as never, 'failed'],
    ];
    for (const [respond, status] of cases) {
      const { stack, scope } = await connected(connector({ respond }));
      const r = await (
        await stack.runtime.connect(scope)
      ).respond({ kind: 'private_reply', target, text: 'x' });
      expect(r.status).toBe(status);
    }
  });

  it('rejects invalid text before calling the connector', async () => {
    const respond = vi.fn();
    const { stack, scope } = await connected(connector({ respond }));
    const r = await (
      await stack.runtime.connect(scope)
    ).respond({ kind: 'public_reply', target, text: '' });
    expect(r.status).toBe('failed');
    expect(respond).not.toHaveBeenCalled();
  });

  it('is unsupported when the kind is not declared', async () => {
    const c = connector();
    const { stack, scope } = await connected({
      ...c,
      capabilities: { ...c.capabilities, responses: ['public_reply'] },
    });
    const r = await (
      await stack.runtime.connect(scope)
    ).respond({ kind: 'private_reply', target, text: 'x' });
    expect(r.status).toBe('unsupported');
  });

  it('supportsResponse reflects the declared kinds', async () => {
    const c = connector();
    const { stack, scope } = await connected({
      ...c,
      capabilities: { ...c.capabilities, responses: ['public_reply'] },
    });
    const client = await stack.runtime.connect(scope);
    expect(client.supportsResponse('public_reply')).toBe(true);
    expect(client.supportsResponse('private_reply')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('setup calls onConnected with the stored token', async () => {
    const c = connector();
    const { stack, scope } = await connected(c);
    await (await stack.runtime.connect(scope)).setup();
    expect(c.lifecycle!.onConnected).toHaveBeenCalledOnce();
    const ctx = vi.mocked(c.lifecycle!.onConnected).mock.calls[0]![0];
    expect(ctx.accessToken.reveal()).toBe('PAGE-TOKEN');
    expect(ctx.externalAccountId).toBe('900');
  });

  it('setup is a no-op without a lifecycle and propagates platform errors', async () => {
    const s1 = await connected(withoutLifecycle());
    await expect((await s1.stack.runtime.connect(s1.scope)).setup()).resolves.toBeUndefined();
    const failing = connector({
      lifecycle: {
        onConnected: async () => {
          throw new ConnectorError('permanent', 'subscribe_failed');
        },
        onDisconnected: async () => {},
      },
    });
    const s2 = await connected(failing);
    await expect((await s2.stack.runtime.connect(s2.scope)).setup()).rejects.toMatchObject({
      kind: 'permanent',
      code: 'subscribe_failed',
    });
  });

  it('teardown works on a disconnected (revoked) connection', async () => {
    const c = connector();
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('done');
    expect(c.lifecycle!.onDisconnected).toHaveBeenCalledOnce();
    const ctx = vi.mocked(c.lifecycle!.onDisconnected).mock.calls[0]![0];
    expect(ctx.accessToken.reveal()).toBe('PAGE-TOKEN');
    expect(ctx.externalAccountId).toBe('900');
  });

  it('teardown deletes the stored credentials; no credential remains afterwards', async () => {
    const { stack, scope } = await connected(connector());
    await stack.vault.writeRefreshToken(scope, { value: new Secret('REFRESH'), expiresAt: null });
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('done');
    expect(await stack.vault.readTokens(scope)).toEqual({ access: null, refresh: null });
    // a repeat run finds nothing to revoke
    expect(await stack.runtime.teardown(scope)).toBe('no_token');
  });

  it('teardown deletes credentials even without a lifecycle', async () => {
    const { stack, scope } = await connected(withoutLifecycle());
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('no_lifecycle');
    expect(await stack.vault.readTokens(scope)).toEqual({ access: null, refresh: null });
  });

  it('teardown refuses a connection that is not revoked and leaves its tokens', async () => {
    const c = connector();
    const { stack, scope } = await connected(c);
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'connection_not_revoked',
    });
    expect(c.lifecycle!.onDisconnected).not.toHaveBeenCalled();
    expect((await stack.vault.readTokens(scope)).access?.value.reveal()).toBe('PAGE-TOKEN');
  });

  it('teardown leaves a page alone when it is reconnected while the teardown runs', async () => {
    const c = connector();
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    const read = vi.spyOn(stack.vault, 'readTokens');
    read.mockImplementationOnce(async (s) => {
      const tokens = await stack.vault.readTokens(s);
      await stack.directory.upsertPending({
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        platform: 'facebook',
        externalAccountId: '900',
        displayName: null,
        grantedScopes: ['s'],
      });
      await stack.vault.writeAccessToken(s, { value: new Secret('NEW-TOKEN'), expiresAt: null });
      await stack.directory.activate(s, stack.actor.userId);
      return tokens;
    });
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'connection_not_revoked',
    });
    expect(c.lifecycle!.onDisconnected).not.toHaveBeenCalled();
    expect((await stack.vault.readTokens(scope)).access?.value.reveal()).toBe('NEW-TOKEN');
  });

  it('teardown throws not_found for an unknown connection', async () => {
    const { stack, scope } = await connected(connector());
    await expect(
      stack.runtime.teardown({ ...scope, connectionId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'connection_not_found' });
  });

  it('teardown keeps tokens on a retryable platform failure so a retry can finish', async () => {
    const c = connector({
      lifecycle: {
        onConnected: async () => {},
        onDisconnected: async () => {
          throw new ConnectorError('transient', 'graph_unavailable');
        },
      },
    });
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'transient',
      code: 'graph_unavailable',
    });
    expect((await stack.vault.readTokens(scope)).access).not.toBeNull();
  });

  it('teardown on the final attempt deletes tokens even after a retryable failure', async () => {
    const c = connector({
      lifecycle: {
        onConnected: async () => {},
        onDisconnected: async () => {
          throw new ConnectorError('transient', 'graph_unavailable');
        },
      },
    });
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    await expect(stack.runtime.teardown(scope, { final: true })).rejects.toMatchObject({
      kind: 'transient',
      code: 'graph_unavailable',
    });
    expect(await stack.vault.readTokens(scope)).toEqual({ access: null, refresh: null });
  });

  it('teardown on the final attempt deletes tokens even when the vault read fails', async () => {
    const { stack, scope } = await connected(connector());
    await stack.directory.disconnect(scope, stack.actor.userId);
    const read = vi.spyOn(stack.vault, 'readTokens').mockRejectedValueOnce(new Error('vault down'));
    await expect(stack.runtime.teardown(scope, { final: true })).rejects.toMatchObject({
      kind: 'transient',
      code: 'storage_unavailable',
    });
    read.mockRestore();
    expect(await stack.vault.readTokens(scope)).toEqual({ access: null, refresh: null });
  });

  it('teardown keeps tokens when the vault read fails before the final attempt', async () => {
    const { stack, scope } = await connected(connector());
    await stack.directory.disconnect(scope, stack.actor.userId);
    const read = vi.spyOn(stack.vault, 'readTokens').mockRejectedValueOnce(new Error('vault down'));
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({ kind: 'transient' });
    read.mockRestore();
    expect((await stack.vault.readTokens(scope)).access).not.toBeNull();
  });

  it('teardown deletes tokens on a non-retryable platform failure and rethrows', async () => {
    const c = connector({
      lifecycle: {
        onConnected: async () => {},
        onDisconnected: async () => {
          throw new ConnectorError('auth_expired', 'token_invalid', { reauthorize: true });
        },
      },
    });
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'token_invalid',
    });
    expect(await stack.vault.readTokens(scope)).toEqual({ access: null, refresh: null });
  });

  it('teardown replaces a foreign connector error and never logs the token', async () => {
    const c = connector({
      lifecycle: {
        onConnected: async () => {},
        onDisconnected: async () => {
          throw new Error('boom PAGE-TOKEN');
        },
      },
    });
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    await expect(stack.runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'connector_failure',
    });
    expect(stack.lines.join('\n')).not.toContain('PAGE-TOKEN');
  });

  it('teardown is unavailable when the runtime has no vault', async () => {
    const c = connector();
    const { stack, scope } = await connected(c);
    await stack.directory.disconnect(scope, stack.actor.userId);
    const runtime = new ConnectorRuntime({
      registry: stack.registry,
      directory: stack.directory,
      tokens: stack.tokens,
      budget: stack.budget,
      clock: stack.clock,
      log: stack.log,
      http: () => {
        throw new Error('unused');
      },
    });
    await expect(runtime.teardown(scope)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'teardown_unavailable',
    });
    expect(c.lifecycle!.onDisconnected).not.toHaveBeenCalled();
  });
});
