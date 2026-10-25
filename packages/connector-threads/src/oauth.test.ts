import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConnectorError,
  MemoryConnectionDirectory,
  MemoryCredentialVault,
  MemoryRefreshLock,
  TokenManager,
  createSafeHttp,
  type Connector,
} from '@feedbouncer/connectors';
import { Secret, createLogger } from '@feedbouncer/service-runtime';
import { THREADS_API_HOST, THREADS_SCOPES, type ThreadsConfig } from './config.js';
import type { ThreadsCall } from './api.js';
import { listAccounts } from './accounts.js';
import { buildAuthorizationUrl, exchangeCode, refreshTokens } from './oauth.js';
import { FakeThreads } from './testing/index.js';

const APP_ID = '1234567890';
const APP_SECRET = 'app-SECRET-0123456789';
const REDIRECT = 'https://app.test/api/v1/oauth/threads/callback';
const T0 = Date.parse('2026-10-24T10:00:00Z');
const DAY = 86_400_000;

let nowMs: number;
let fake: FakeThreads;
let cfg: ThreadsConfig;
let call: ThreadsCall;
let seen: string[];

beforeEach(() => {
  nowMs = T0;
  seen = [];
  fake = new FakeThreads({ appId: APP_ID, appSecret: APP_SECRET, now: () => new Date(nowMs) });
  cfg = {
    appId: APP_ID,
    appSecret: new Secret(APP_SECRET),
    webhookVerifyToken: null,
    pollIntervalSec: 600,
    discoveryIntervalSec: 900,
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    seen.push(`${String(input)} ${typeof init?.body === 'string' ? init.body : ''}`);
    return fake.fetch(input, init);
  };
  call = {
    http: createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch }),
    signal: AbortSignal.timeout(2000),
  };
});

const now = () => new Date(nowMs);
const exchange = (code: string, log?: (m: string, f: Record<string, unknown>) => void) =>
  exchangeCode(cfg, call, { code, redirectUri: REDIRECT, now: now(), ...(log && { log }) });

describe('buildAuthorizationUrl', () => {
  it('authorization url has client_id, redirect_uri, response_type=code, comma-separated scopes and state, on threads.com', () => {
    const u = buildAuthorizationUrl(cfg, {
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      scopes: [...THREADS_SCOPES, 'evil_scope'],
    });
    expect(u.origin + u.pathname).toBe('https://threads.com/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: APP_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: THREADS_SCOPES.join(','),
      state: 's'.repeat(43),
    });
    expect(u.href).not.toContain(APP_SECRET);
  });
});

describe('exchangeCode', () => {
  it('exchange returns a long-lived token whose access expiry is 53 days out and refresh expiry 60 days out', async () => {
    const { authCode, userId } = fake.addUser({ username: 'alice' });
    const { tokens, account } = await exchange(authCode);
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(T0 + 53 * DAY));
    expect(tokens.refreshTokenExpiresAt).toEqual(new Date(T0 + 60 * DAY));
    expect(tokens.refreshToken?.reveal()).toBe(tokens.accessToken.reveal());
    expect(account).toEqual({ externalId: userId, name: 'alice' });
    expect(fake.calls().map((c) => c.endpoint)).toEqual([
      'oauthToken',
      'longLived',
      'debugToken',
      'me',
    ]);
  });

  it('shortens the access expiry to half when the token lives less than two lead periods', async () => {
    const { authCode } = fake.addUser();
    const orig = fake.fetch;
    const short: typeof globalThis.fetch = async (input, init) => {
      const res = await orig(input, init);
      if (!new URL(String(input)).pathname.endsWith('/access_token')) return res;
      return Response.json({ ...((await res.json()) as object), expires_in: 86_400 });
    };
    call = { ...call, http: createSafeHttp({ allowedHosts: [THREADS_API_HOST], fetch: short }) };
    const { tokens } = await exchange(authCode);
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(T0 + 43_200_000));
    expect(tokens.refreshTokenExpiresAt).toEqual(new Date(T0 + DAY));
  });

  it('granted scopes come from debug_token; a user who declined threads_manage_replies gets three scopes', async () => {
    const { authCode } = fake.addUser({
      scopes: ['threads_basic', 'threads_read_replies', 'threads_content_publish'],
    });
    const { tokens } = await exchange(authCode);
    expect([...tokens.scopes].sort()).toEqual(
      ['threads_basic', 'threads_content_publish', 'threads_read_replies'].sort(),
    );
  });

  it('debug_token refused → all default scopes, no throw', async () => {
    const { authCode } = fake.addUser({ scopes: ['threads_basic', 'threads_read_replies'] });
    fake.failNext('debugToken', { code: 10 });
    const logs: string[] = [];
    const { tokens } = await exchange(authCode, (m) => logs.push(m));
    expect([...tokens.scopes]).toEqual([...THREADS_SCOPES]);
    expect(logs).toEqual(['threads.debug_token_unavailable']);
  });

  it('a transient debug_token failure is not swallowed', async () => {
    const { authCode } = fake.addUser();
    fake.failNext('debugToken', { httpStatus: 500 });
    await expect(exchange(authCode)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('no error message or URL from any step contains the client secret or code', async () => {
    const { authCode } = fake.addUser();
    const logs: string[] = [];
    const log = (m: string, f: Record<string, unknown>) => logs.push(m + JSON.stringify(f));
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    await attempt(() => exchange('wrong-code-XYZ', log));
    await attempt(() => {
      cfg = { ...cfg, appSecret: new Secret('wrong-SECRET-0000') };
      return exchange(authCode, log);
    });
    for (const endpoint of ['longLived', 'debugToken', 'me'] as const) {
      const u = fake.addUser();
      fake.failNext(endpoint, { code: 190 });
      cfg = { ...cfg, appSecret: new Secret(APP_SECRET) };
      await attempt(() => exchange(u.authCode, log));
    }
    expect(errors).toHaveLength(5);
    for (const e of errors) {
      expect(e).toBeInstanceOf(ConnectorError);
      const text = `${(e as Error).message} ${JSON.stringify(e)} ${(e as Error).stack}`;
      for (const s of [APP_SECRET, authCode, 'wrong-code-XYZ', 'wrong-SECRET-0000']) {
        expect(text).not.toContain(s);
      }
    }
    expect(logs.join('\n')).not.toContain(APP_SECRET);
    // The secret does travel to Meta, as the platform requires, but never in the code/URL path of an error.
    expect(seen.some((s) => s.includes(APP_SECRET))).toBe(true);
  });
});

describe('refreshTokens', () => {
  it('refreshTokens calls th_refresh_token with the stored token and returns a new 60-day set', async () => {
    const { authCode } = fake.addUser();
    const { tokens } = await exchange(authCode);
    nowMs = T0 + 54 * DAY;
    const next = await refreshTokens(call, tokens.refreshToken!, now());
    expect(next.accessToken.reveal()).not.toBe(tokens.accessToken.reveal());
    expect(next.accessTokenExpiresAt).toEqual(new Date(nowMs + 53 * DAY));
    expect(next.refreshTokenExpiresAt).toEqual(new Date(nowMs + 60 * DAY));
    expect(next.refreshToken?.reveal()).toBe(next.accessToken.reveal());
    const last = fake.calls().at(-1)!;
    expect(last.endpoint).toBe('refresh');
    expect(last.query).toEqual({
      grant_type: 'th_refresh_token',
      access_token: tokens.refreshToken!.reveal(),
    });
  });

  it('refresh of a revoked token → auth_expired', async () => {
    const { authCode } = fake.addUser();
    const { tokens } = await exchange(authCode);
    fake.revokeToken(tokens.refreshToken!.reveal());
    await expect(refreshTokens(call, tokens.refreshToken!, now())).rejects.toMatchObject({
      kind: 'auth_expired',
    });
  });
});

describe('listAccounts', () => {
  it('lists exactly the token owner, carrying that token', async () => {
    const { authCode, userId } = fake.addUser({ username: 'alice' });
    const { tokens } = await exchange(authCode);
    const accounts = await listAccounts({ ...call, accessToken: tokens.accessToken.reveal() });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      externalAccountId: userId,
      displayName: 'alice',
      eligible: true,
      ineligibleReason: null,
      limitations: [],
    });
    expect(accounts[0]!.accessToken.reveal()).toBe(tokens.accessToken.reveal());
    expect(fake.calls().at(-1)!.query.fields).toBe('id,username,name');
  });
});

describe('TokenManager with Threads self-refresh', () => {
  it('TokenManager refreshes once at day 53 and persists the new expiry', async () => {
    const { authCode } = fake.addUser();
    const { tokens } = await exchange(authCode);
    const scope = { organizationId: 'o1', brandId: 'b1', connectionId: 'c1' };
    const vault = new MemoryCredentialVault();
    const directory = new MemoryConnectionDirectory();
    directory.seed({ scope, platform: 'threads', externalAccountId: 'x', status: 'active' });
    await vault.writeRefreshToken(scope, {
      value: tokens.refreshToken!,
      expiresAt: tokens.refreshTokenExpiresAt,
    });
    await vault.writeAccessToken(scope, {
      value: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
    });
    const connector = {
      platform: 'threads',
      capabilities: { tokens: { refreshable: true, rotatesRefreshToken: true } },
      refreshTokens: async (rt: Secret) => refreshTokens(call, rt, now()),
    } as unknown as Connector;
    const tm = new TokenManager({
      vault,
      directory,
      lock: new MemoryRefreshLock(),
      clock: { now: () => nowMs },
      log: createLogger('t', 'debug', () => {}),
      oauthContext: () => ({ ...call, redirectUri: REDIRECT }),
    });
    const refreshes = () => fake.calls('refresh').length;

    nowMs = T0 + 52 * DAY;
    expect((await tm.accessToken(connector, scope)).reveal()).toBe(tokens.accessToken.reveal());
    expect(refreshes()).toBe(0);

    nowMs = T0 + 53 * DAY + 1000;
    const [a, b] = await Promise.all([
      tm.accessToken(connector, scope),
      tm.accessToken(connector, scope),
    ]);
    expect(a.reveal()).toBe(b.reveal());
    expect(a.reveal()).not.toBe(tokens.accessToken.reveal());
    expect(refreshes()).toBe(1);

    const stored = await vault.readTokens(scope);
    expect(stored.access?.expiresAt).toEqual(new Date(nowMs + 53 * DAY));
    expect(stored.refresh?.expiresAt).toEqual(new Date(nowMs + 60 * DAY));

    expect((await tm.accessToken(connector, scope)).reveal()).toBe(a.reveal());
    expect(refreshes()).toBe(1);
  });
});
