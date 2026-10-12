import { describe, expect, it, vi } from 'vitest';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import type { Connector, TokenSet } from './connector.js';
import { ConnectorError } from './errors.js';
import { MemoryConnectionDirectory, MemoryCredentialVault, MemoryRefreshLock } from './memory.js';
import { TokenManager } from './tokens.js';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const scope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c1' };

function setup(
  refresh: (rt: Secret) => Promise<TokenSet>,
  caps = { refreshable: true, rotatesRefreshToken: true },
  shared?: {
    vault: MemoryCredentialVault;
    directory: MemoryConnectionDirectory;
    lock: MemoryRefreshLock;
  },
) {
  const vault = shared?.vault ?? new MemoryCredentialVault();
  const directory = shared?.directory ?? new MemoryConnectionDirectory();
  const lock = shared?.lock ?? new MemoryRefreshLock();
  if (!shared)
    directory.seed({ scope, platform: 'facebook', externalAccountId: 'p1', status: 'active' });
  const refreshTokens = vi.fn(refresh);
  const connector = {
    platform: 'facebook',
    capabilities: { tokens: caps },
    refreshTokens,
  } as unknown as Connector;
  const lines: string[] = [];
  const tm = new TokenManager({
    vault,
    directory,
    lock,
    clock: { now: () => NOW },
    log: createLogger('t', 'debug', (l) => lines.push(l)),
    oauthContext: () => ({
      http: {
        request: async () => {
          throw new Error('no');
        },
      },
      signal: AbortSignal.timeout(1000),
      redirectUri: 'https://app.test/cb',
    }),
  });
  return { vault, directory, lock, connector, refreshTokens, tm, lines };
}
const tokens = (n: number, rotate = true): TokenSet => ({
  accessToken: new Secret(`access-${n}`),
  accessTokenExpiresAt: new Date(NOW + 3_600_000),
  refreshToken: rotate ? new Secret(`refresh-${n}`) : null,
  refreshTokenExpiresAt: null,
  scopes: [],
});

describe('TokenManager', () => {
  it('returns a fresh stored token without refreshing', async () => {
    const s = setup(async () => tokens(1));
    await s.vault.writeAccessToken(scope, {
      value: new Secret('access-0'),
      expiresAt: new Date(NOW + 600_000),
    });
    expect((await s.tm.accessToken(s.connector, scope)).reveal()).toBe('access-0');
    expect(s.refreshTokens).not.toHaveBeenCalled();
  });

  it('treats tokens inside the skew window as expired', async () => {
    const s = setup(async () => tokens(1));
    await s.vault.writeAccessToken(scope, {
      value: new Secret('access-0'),
      expiresAt: new Date(NOW + 60_000),
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    expect((await s.tm.accessToken(s.connector, scope)).reveal()).toBe('access-1');
  });

  it('concurrent callers trigger exactly one refresh and share its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup(async () => {
      await gate;
      return tokens(1);
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    const calls = Array.from({ length: 10 }, () => s.tm.accessToken(s.connector, scope));
    release();
    const got = await Promise.all(calls);
    expect(s.refreshTokens).toHaveBeenCalledTimes(1);
    expect(new Set(got.map((t) => t.reveal()))).toEqual(new Set(['access-1']));
  });

  it('a waiter in another process reuses the token stored while it waited for the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const a = setup(async () => {
      started();
      await gate;
      return tokens(1);
    });
    const b = setup(async () => tokens(9), undefined, a);
    await a.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    const first = a.tm.accessToken(a.connector, scope);
    await inFlight;
    const second = b.tm.accessToken(b.connector, scope);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const got = await Promise.all([first, second]);
    expect(got.map((t) => t.reveal())).toEqual(['access-1', 'access-1']);
    expect(a.refreshTokens).toHaveBeenCalledTimes(1);
    expect(b.refreshTokens).not.toHaveBeenCalled();
  });

  it('a rejected token equal to the stored, unexpired one forces a refresh', async () => {
    const s = setup(async () => tokens(1));
    await s.vault.writeAccessToken(scope, {
      value: new Secret('access-0'),
      expiresAt: new Date(NOW + 600_000),
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    const got = await s.tm.accessToken(s.connector, scope, { rejected: new Secret('access-0') });
    expect(got.reveal()).toBe('access-1');
    expect(s.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("a mismatched tenant scope never joins another tenant's in-flight refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const s = setup(async () => {
      started();
      await gate;
      return tokens(1);
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    const legit = s.tm.accessToken(s.connector, scope);
    await inFlight;
    const wrong = { ...scope, organizationId: 'o2' };
    await expect(s.tm.accessToken(s.connector, wrong)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'connection_inactive',
    });
    release();
    expect((await legit).reveal()).toBe('access-1');
    expect(s.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('refuses to refresh a connection that is not active, without calling the platform', async () => {
    const s = setup(async () => tokens(1));
    s.directory.seed({
      scope,
      platform: 'facebook',
      externalAccountId: 'p1',
      status: 'reconnect_required',
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'connection_inactive',
      reauthorize: true,
    });
    expect(s.refreshTokens).not.toHaveBeenCalled();
    expect((await s.vault.readTokens(scope)).access).toBeNull();
  });

  it('a revoked connection is terminal: auth_expired without reauthorize, no platform call', async () => {
    const s = setup(async () => tokens(1));
    s.directory.seed({ scope, platform: 'facebook', externalAccountId: 'p1', status: 'revoked' });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'connection_inactive',
      reauthorize: false,
    });
    expect(s.refreshTokens).not.toHaveBeenCalled();
  });

  it('persists a rotated refresh token before the access token (Review Focus 4)', async () => {
    const s = setup(async (rt) => tokens(Number(rt.reveal().split('-')[1]) + 1));
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    s.vault.failNextWrite('access');
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toThrow();
    expect((await s.vault.readTokens(scope)).refresh?.value.reveal()).toBe('refresh-1');
    expect((await s.tm.accessToken(s.connector, scope)).reveal()).toBe('access-2');
    expect(s.refreshTokens.mock.calls.map(([rt]) => rt.reveal())).toEqual([
      'refresh-0',
      'refresh-1',
    ]);
  });

  it('keeps the existing refresh token when the platform does not rotate', async () => {
    const s = setup(async () => tokens(1, false), {
      refreshable: true,
      rotatesRefreshToken: false,
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await s.tm.accessToken(s.connector, scope);
    expect((await s.vault.readTokens(scope)).refresh?.value.reveal()).toBe('refresh-0');
  });

  it('a rejected refresh marks reconnect_required, throws reauthorize, and is not retried', async () => {
    const s = setup(async () => {
      throw new ConnectorError('auth_expired', 'invalid_grant');
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toMatchObject({
      kind: 'auth_expired',
      reauthorize: true,
    });
    expect((await s.directory.load(scope))?.status).toBe('reconnect_required');
    expect(s.directory.statusReason('c1')).toBe('oauth_refresh_rejected');
    expect(s.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('transient refresh failures do not flag the connection', async () => {
    const s = setup(async () => {
      throw new ConnectorError('transient', 'timeout');
    });
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toMatchObject({ kind: 'transient' });
    expect((await s.directory.load(scope))?.status).toBe('active');
  });

  it('no refresh token (or not refreshable) means reauthorization, without calling the platform', async () => {
    const s = setup(async () => tokens(1));
    await expect(s.tm.accessToken(s.connector, scope)).rejects.toMatchObject({
      reauthorize: true,
      code: 'oauth_not_refreshable',
    });
    expect(s.refreshTokens).not.toHaveBeenCalled();
  });

  it('never logs token values', async () => {
    const s = setup(async () => tokens(1));
    await s.vault.writeRefreshToken(scope, { value: new Secret('refresh-0'), expiresAt: null });
    await s.tm.accessToken(s.connector, scope);
    expect(s.lines.join('\n')).not.toMatch(/access-1|refresh-0|refresh-1/);
  });
});
