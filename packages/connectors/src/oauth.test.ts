import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { Connector } from './connector.js';
import {
  MemoryConnectionDirectory,
  MemoryCredentialVault,
  MemoryMembershipReader,
  MemoryOAuthStateStore,
} from './memory.js';
import { OAuthAccessDeniedError, OAuthFlow, STATE_PATTERN } from './oauth.js';
import { ConnectorRegistry } from './registry.js';

let now = Date.parse('2026-10-12T10:00:00Z');
const alice = { userId: 'alice', organizationId: 'o1', brandId: 'b1' };
const exchange = vi.fn();

function stubConnector(platform: Connector['platform'] = 'youtube'): Connector {
  return {
    platform,
    capabilities: {
      actions: ['hide'],
      listSources: false,
      recentSources: false,
      ingestion: 'polling',
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: { points: 10, durationSec: 60, urgentReservePoints: 1, defaultRetryAfterMs: 1000 },
      apiHosts: ['api.reference.test'],
      authorizationHosts: ['auth.reference.test'],
      defaultScopes: ['comments'],
      maxPageSize: 10,
    },
    buildAuthorizationUrl: ({ state, codeChallenge, redirectUri, scopes }) => {
      const u = new URL('https://auth.reference.test/authorize');
      u.search = new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
      }).toString();
      return u;
    },
    exchangeCode: exchange,
    refreshTokens: async () => {
      throw new Error('unused');
    },
    listComments: async () => ({ items: [], nextCursor: null }),
    getComment: async () => null,
    act: async () => ({ status: 'not_found' }),
  };
}

let states: MemoryOAuthStateStore;
let directory: MemoryConnectionDirectory;
let vault: MemoryCredentialVault;
let memberships: MemoryMembershipReader;
let lines: string[];

function makeFlow(registry: ConnectorRegistry): OAuthFlow {
  return new OAuthFlow({
    registry,
    states,
    memberships,
    directory,
    vault,
    clock: { now: () => now },
    log: createLogger('t', 'debug', (l) => lines.push(l)),
    redirectUri: () => 'https://app.feedbouncer.test/oauth/callback',
    http: () => ({
      request: async () => {
        throw new Error('no');
      },
    }),
  });
}

function stubRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(stubConnector());
  registry.register(stubConnector('facebook'));
  return registry;
}

let flow: OAuthFlow;

beforeEach(() => {
  exchange.mockReset();
  exchange.mockImplementation(async () => ({
    tokens: {
      accessToken: new Secret('access-SENTINEL'),
      accessTokenExpiresAt: null,
      refreshToken: new Secret('refresh-SENTINEL'),
      refreshTokenExpiresAt: null,
      scopes: ['comments'],
    },
    account: { externalAccountId: 'chan-1', displayName: 'Channel' },
  }));
  memberships = new MemoryMembershipReader();
  memberships.grant('o1', 'b1', 'alice', 'admin');
  memberships.grant('o1', 'b1', 'mallory', 'admin');
  memberships.grant('o1', 'b2', 'alice', 'admin');
  memberships.grant('o1', 'b1', 'bob', 'member');
  states = new MemoryOAuthStateStore();
  directory = new MemoryConnectionDirectory();
  vault = new MemoryCredentialVault();
  lines = [];
  flow = makeFlow(stubRegistry());
});

const stateOf = (u: URL) => u.searchParams.get('state')!;

describe('OAuthFlow.start', () => {
  it('issues a 43-char state, S256 challenge and stores only a hash', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(stateOf(authorizationUrl)).toMatch(STATE_PATTERN);
    expect(authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(states.size()).toBe(1);
  });

  it('refuses members without connection.manage and non-members', async () => {
    await expect(flow.start({ ...alice, userId: 'bob' }, 'youtube')).rejects.toBeInstanceOf(
      OAuthAccessDeniedError,
    );
    await expect(flow.start({ ...alice, userId: 'eve' }, 'youtube')).rejects.toBeInstanceOf(
      OAuthAccessDeniedError,
    );
    expect(states.size()).toBe(0);
  });

  it('refuses reconnecting a connection outside the actor brand', async () => {
    await expect(
      flow.start(alice, 'youtube', { reconnectConnectionId: 'not-mine' }),
    ).rejects.toBeInstanceOf(OAuthAccessDeniedError);
  });

  it('refuses reconnecting a connection that belongs to another brand', async () => {
    const first = await flow.start(alice, 'youtube');
    const done = await flow.complete(alice, 'youtube', {
      state: stateOf(first.authorizationUrl),
      code: 'c',
    });
    if (!done.ok || done.kind !== 'connected') throw new Error('setup');
    await expect(
      flow.start({ ...alice, brandId: 'b2' }, 'youtube', {
        reconnectConnectionId: done.connectionId,
      }),
    ).rejects.toBeInstanceOf(OAuthAccessDeniedError);
  });
});

describe('OAuthFlow.complete', () => {
  it('exchanges the code with the stored PKCE verifier and stores credentials', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const res = await flow.complete(alice, 'youtube', {
      state: stateOf(authorizationUrl),
      code: 'auth-code-SENTINEL',
    });
    expect(res).toMatchObject({ ok: true, kind: 'connected', created: true });
    const [{ code, codeVerifier }] = exchange.mock.calls[0] as [
      { code: Secret; codeVerifier: Secret },
    ];
    expect(code.reveal()).toBe('auth-code-SENTINEL');
    expect(createHash('sha256').update(codeVerifier.reveal()).digest('base64url')).toBe(
      authorizationUrl.searchParams.get('code_challenge'),
    );
    if (!res.ok || res.kind !== 'connected') return;
    const scope = { organizationId: 'o1', brandId: 'b1', connectionId: res.connectionId };
    expect((await directory.load(scope))?.status).toBe('active');
    expect((await vault.readTokens(scope)).refresh?.value.reveal()).toBe('refresh-SENTINEL');
    expect((await vault.readTokens(scope)).access?.value.reveal()).toBe('access-SENTINEL');
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('rejects a replayed callback', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const q = { state: stateOf(authorizationUrl), code: 'c' };
    expect((await flow.complete(alice, 'youtube', q)).ok).toBe(true);
    expect(await flow.complete(alice, 'youtube', q)).toEqual({ ok: false, reason: 'rejected' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired state', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    now += 600_001;
    expect(
      await flow.complete(alice, 'youtube', { state: stateOf(authorizationUrl), code: 'c' }),
    ).toEqual({ ok: false, reason: 'rejected' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['missing state', { code: 'c' }],
    ['malformed state', { state: 'short', code: 'c' }],
    ['array state', { state: ['a', 'b'], code: 'c' }],
    ['unknown state', { state: 'A'.repeat(43), code: 'c' }],
  ])('rejects %s', async (_n, q) => {
    await flow.start(alice, 'youtube');
    expect(await flow.complete(alice, 'youtube', q)).toEqual({ ok: false, reason: 'rejected' });
  });

  it('rejects a callback in another user session without consuming the state', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const q = { state: stateOf(authorizationUrl), code: 'c' };
    expect(await flow.complete({ ...alice, userId: 'mallory' }, 'youtube', q)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(await flow.complete({ ...alice, brandId: 'b2' }, 'youtube', q)).toEqual({
      ok: false,
      reason: 'rejected',
    });
    expect(states.size()).toBe(1);
    expect((await flow.complete(alice, 'youtube', q)).ok).toBe(true);
  });

  it('rejects a callback for a different platform', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(
      await flow.complete(alice, 'facebook', { state: stateOf(authorizationUrl), code: 'c' }),
    ).toEqual({ ok: false, reason: 'rejected' });
  });

  it('reports user denial after validating (and consuming) the state', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(
      await flow.complete(alice, 'youtube', {
        state: stateOf(authorizationUrl),
        error: 'access_denied',
        error_reason: 'user_denied',
      }),
    ).toEqual({ ok: false, reason: 'denied' });
    expect(states.size()).toBe(0);
  });

  it('error=access_denied is a user denial', async () => {
    const { authorizationUrl } = await flow.start(alice, 'facebook');
    expect(
      await flow.complete(alice, 'facebook', {
        state: stateOf(authorizationUrl),
        error: 'access_denied',
      }),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  it('complete reads auth_code when the connector declares oauthCodeParam auth_code', async () => {
    const registry = new ConnectorRegistry();
    const c = stubConnector();
    registry.register({ ...c, capabilities: { ...c.capabilities, oauthCodeParam: 'auth_code' } });
    const f = makeFlow(registry);
    const { authorizationUrl } = await f.start(alice, 'youtube');
    const r = await f.complete(alice, 'youtube', {
      state: stateOf(authorizationUrl),
      auth_code: 'X',
    });
    expect(r.ok).toBe(true);
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: expect.objectContaining({}) }),
      expect.anything(),
    );
    expect(exchange.mock.calls[0]![0].code.reveal()).toBe('X');
  });

  it('a default connector rejects an auth_code callback', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(
      await flow.complete(alice, 'youtube', { state: stateOf(authorizationUrl), auth_code: 'X' }),
    ).toEqual({ ok: false, reason: 'rejected' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('maps exchange failures to platform_error without leaking', async () => {
    exchange.mockRejectedValueOnce(new Error('invalid code auth-code-SENTINEL'));
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(
      await flow.complete(alice, 'youtube', {
        state: stateOf(authorizationUrl),
        code: 'auth-code-SENTINEL',
      }),
    ).toEqual({ ok: false, reason: 'platform_error' });
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('rejects reconnecting with a different platform account', async () => {
    const first = await flow.start(alice, 'youtube');
    const done = await flow.complete(alice, 'youtube', {
      state: stateOf(first.authorizationUrl),
      code: 'c',
    });
    if (!done.ok || done.kind !== 'connected') throw new Error('setup');
    const again = await flow.start(alice, 'youtube', { reconnectConnectionId: done.connectionId });
    exchange.mockResolvedValueOnce({
      tokens: {
        accessToken: new Secret('a2'),
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scopes: [],
      },
      account: { externalAccountId: 'chan-OTHER', displayName: null },
    });
    expect(
      await flow.complete(alice, 'youtube', { state: stateOf(again.authorizationUrl), code: 'c' }),
    ).toEqual({ ok: false, reason: 'account_mismatch' });
  });

  describe('revoked connections are terminal', () => {
    const connect = async () => {
      const first = await flow.start(alice, 'youtube');
      const done = await flow.complete(alice, 'youtube', {
        state: stateOf(first.authorizationUrl),
        code: 'c',
      });
      if (!done.ok || done.kind !== 'connected') throw new Error('setup');
      const scope = { organizationId: 'o1', brandId: 'b1', connectionId: done.connectionId };
      return { scope, rec: (await directory.load(scope))! };
    };
    /** Token values as text: toEqual cannot see inside a Secret. */
    const stored = async (scope: ConnectionScope) => {
      const t = await vault.readTokens(scope);
      return { access: t.access?.value.reveal(), refresh: t.refresh?.value.reveal() };
    };

    it('stores nothing and reports connection_inactive when reconnecting a revoked connection', async () => {
      const { scope, rec } = await connect();
      directory.seed({ ...rec, status: 'revoked' });
      const before = await stored(scope);
      exchange.mockResolvedValueOnce({
        tokens: {
          accessToken: new Secret('access-NEW'),
          accessTokenExpiresAt: null,
          refreshToken: new Secret('refresh-NEW'),
          refreshTokenExpiresAt: null,
          scopes: [],
        },
        account: { externalAccountId: 'chan-1', displayName: null },
      });
      const again = await flow.start(alice, 'youtube', {
        reconnectConnectionId: scope.connectionId,
      });
      expect(
        await flow.complete(alice, 'youtube', {
          state: stateOf(again.authorizationUrl),
          code: 'c',
        }),
      ).toEqual({ ok: false, reason: 'connection_inactive' });
      expect(await stored(scope)).toEqual(before);
      expect((await directory.load(scope))?.status).toBe('revoked');
    });

    it('stores nothing when a fresh authorization lands on a revoked connection', async () => {
      const { scope, rec } = await connect();
      directory.seed({ ...rec, status: 'revoked' });
      const before = await stored(scope);
      exchange.mockResolvedValueOnce({
        tokens: {
          accessToken: new Secret('access-NEW'),
          accessTokenExpiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scopes: [],
        },
        account: { externalAccountId: 'chan-1', displayName: null },
      });
      const again = await flow.start(alice, 'youtube');
      expect(
        await flow.complete(alice, 'youtube', {
          state: stateOf(again.authorizationUrl),
          code: 'c',
        }),
      ).toEqual({ ok: false, reason: 'connection_inactive' });
      expect(await stored(scope)).toEqual(before);
    });

    it.each([false, true])(
      'stores no tokens when authorizing a paused connection (reconnect: %s)',
      async (reconnect) => {
        const { scope, rec } = await connect();
        directory.seed({ ...rec, status: 'paused' });
        const before = await stored(scope);
        exchange.mockResolvedValueOnce({
          tokens: {
            accessToken: new Secret('access-NEW'),
            accessTokenExpiresAt: null,
            refreshToken: new Secret('refresh-NEW'),
            refreshTokenExpiresAt: null,
            scopes: [],
          },
          account: { externalAccountId: 'chan-1', displayName: null },
        });
        const again = await flow.start(
          alice,
          'youtube',
          reconnect ? { reconnectConnectionId: scope.connectionId } : {},
        );
        expect(
          await flow.complete(alice, 'youtube', {
            state: stateOf(again.authorizationUrl),
            code: 'c',
          }),
        ).toEqual({ ok: false, reason: 'connection_inactive' });
        expect(await stored(scope)).toEqual(before);
        expect((await directory.load(scope))?.status).toBe('paused');
      },
    );

    it('never reports ok when activation did not take effect', async () => {
      vi.spyOn(directory, 'activate').mockResolvedValue({
        activated: false,
        reviewMode: { state: 'off', endsAt: null, changed: false },
      });
      const first = await flow.start(alice, 'youtube');
      expect(
        await flow.complete(alice, 'youtube', {
          state: stateOf(first.authorizationUrl),
          code: 'c',
        }),
      ).toEqual({ ok: false, reason: 'connection_inactive' });
    });
  });

  it('stores the tokens with no expiry when the connector reports invalid expiries', async () => {
    exchange.mockResolvedValueOnce({
      tokens: {
        accessToken: new Secret('access-SENTINEL'),
        accessTokenExpiresAt: new Date(Number.NaN),
        refreshToken: new Secret('refresh-SENTINEL'),
        refreshTokenExpiresAt: 12345 as never,
        scopes: ['comments'],
      },
      account: { externalAccountId: 'chan-1', displayName: 'Channel' },
    });
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const res = await flow.complete(alice, 'youtube', {
      state: stateOf(authorizationUrl),
      code: 'auth-code',
    });
    expect(res).toMatchObject({ ok: true });
    if (!res.ok || res.kind !== 'connected') return;
    const t = await vault.readTokens({
      organizationId: 'o1',
      brandId: 'b1',
      connectionId: res.connectionId,
    });
    expect(t.refresh).toMatchObject({ expiresAt: null });
    expect(t.access).toMatchObject({ expiresAt: null });
    expect(lines.join('\n')).toContain('invalid_token_expiry');
  });

  it.each([
    ['a plain-string access token', { accessToken: 'access-SENTINEL' }],
    ['more than 100 scopes', { scopes: Array.from({ length: 101 }, (_, i) => `s${i}`) }],
    ['a scope with a control character', { scopes: ['comments\u0000'] }],
  ])('reports platform_error and stores nothing for %s', async (_, bad) => {
    exchange.mockResolvedValueOnce({
      tokens: {
        accessToken: new Secret('access-1'),
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scopes: ['comments'],
        ...bad,
      },
      account: { externalAccountId: 'chan-1', displayName: 'Channel' },
    });
    const upsert = vi.spyOn(directory, 'upsertPending');
    const writes = [vi.spyOn(vault, 'writeAccessToken'), vi.spyOn(vault, 'writeRefreshToken')];
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    expect(
      await flow.complete(alice, 'youtube', { state: stateOf(authorizationUrl), code: 'c' }),
    ).toEqual({ ok: false, reason: 'platform_error' });
    expect(upsert).not.toHaveBeenCalled();
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });

  it('rejects codes with control characters or excessive length', async () => {
    for (const code of ['a\nb', 'x'.repeat(2049), '']) {
      const { authorizationUrl } = await flow.start(alice, 'youtube');
      expect(
        await flow.complete(alice, 'youtube', { state: stateOf(authorizationUrl), code }),
      ).toEqual({ ok: false, reason: 'rejected' });
    }
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a malformed code does not burn the pending state', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const state = stateOf(authorizationUrl);
    for (const code of ['a\nb', 'x'.repeat(2049), '', undefined, 42])
      expect(await flow.complete(alice, 'youtube', { state, code })).toEqual({
        ok: false,
        reason: 'rejected',
      });
    expect(exchange).not.toHaveBeenCalled();
    expect(await flow.complete(alice, 'youtube', { state, code: 'good-code' })).toMatchObject({
      ok: true,
    });
  });

  it('a user denial is reported as denied even without a code', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const state = stateOf(authorizationUrl);
    expect(
      await flow.complete(alice, 'youtube', {
        state,
        error: 'access_denied',
        error_reason: 'user_denied',
      }),
    ).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(await flow.complete(alice, 'youtube', { state, code: 'good-code' })).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('provider error with error_reason=user_denied -> denied', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const state = stateOf(authorizationUrl);
    expect(
      await flow.complete(alice, 'youtube', {
        state,
        error: 'access_denied',
        error_reason: 'user_denied',
      }),
    ).toEqual({ ok: false, reason: 'denied' });
  });

  it('a Facebook error with any other reason -> provider_error', async () => {
    const { authorizationUrl } = await flow.start(alice, 'facebook');
    const state = stateOf(authorizationUrl);
    expect(
      await flow.complete(alice, 'facebook', {
        state,
        error: 'server_error',
        error_reason: 'other',
      }),
    ).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('a Facebook error without error_reason -> provider_error', async () => {
    const { authorizationUrl } = await flow.start(alice, 'facebook');
    const state = stateOf(authorizationUrl);
    expect(await flow.complete(alice, 'facebook', { state, error: 'server_error' })).toEqual({
      ok: false,
      reason: 'provider_error',
    });
  });

  it('a YouTube cancel (plain access_denied) -> denied', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    const state = stateOf(authorizationUrl);
    expect(await flow.complete(alice, 'youtube', { state, error: 'access_denied' })).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('provider error text is not logged', async () => {
    const { authorizationUrl } = await flow.start(alice, 'facebook');
    await flow.complete(alice, 'facebook', {
      state: stateOf(authorizationUrl),
      error: 'server_error',
      error_description: 'DESCRIPTION-SENTINEL',
    });
    expect(lines.join('\n')).not.toContain('DESCRIPTION-SENTINEL');
    expect(lines.join('\n')).toContain('oauth provider error');
  });

  it('refuses a non-manager completing a callback', async () => {
    const { authorizationUrl } = await flow.start(alice, 'youtube');
    memberships.grant('o1', 'b1', 'alice', 'member');
    expect(
      await flow.complete(alice, 'youtube', { state: stateOf(authorizationUrl), code: 'c' }),
    ).toEqual({ ok: false, reason: 'rejected' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('refuses an authorization URL on a host the connector did not declare', async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      ...stubConnector(),
      buildAuthorizationUrl: () => new URL('https://evil.example/authorize'),
    });
    await expect(makeFlow(registry).start(alice, 'youtube')).rejects.toMatchObject({
      code: 'disallowed_url',
    });
    expect(states.size()).toBe(0);
  });
});
