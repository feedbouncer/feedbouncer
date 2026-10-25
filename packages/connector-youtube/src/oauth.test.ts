import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSafeHttp, type OAuthContext, type QuotaMeter } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import {
  API_HOSTS,
  YOUTUBE_SCOPE_SHORT,
  YOUTUBE_SCOPE_URL,
  type YouTubeConnectorConfig,
} from './config.js';
import {
  buildAuthorizationUrl,
  exchangeCode,
  listAccounts,
  refreshTokens,
  revoke,
} from './oauth.js';
import { FakeYouTube } from './testing/index.js';

const CLIENT = {
  clientId: '1234-abc.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-SECRET-0123456789',
};
const CHANNEL = 'UC' + 'c'.repeat(22);
const REDIRECT = 'https://app.test/api/v1/oauth/youtube/callback';
const NOW = Date.parse('2026-10-24T10:00:00Z');
const now = () => NOW;

let fake: FakeYouTube;
let ctx: OAuthContext;
let meter: QuotaMeter & {
  reserve: ReturnType<typeof vi.fn<QuotaMeter['reserve']>>;
  settle: ReturnType<typeof vi.fn<QuotaMeter['settle']>>;
};
let cfg: YouTubeConnectorConfig;
let seen: { url: string; body: string }[];

function setup(
  channel: { id: string; title: string } | null = { id: CHANNEL, title: 'My channel' },
) {
  fake = new FakeYouTube({ ...CLIENT, channel, clock: now });
  seen = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    seen.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
    return fake.fetch(input, init);
  };
  ctx = {
    http: createSafeHttp({ allowedHosts: API_HOSTS, fetch }),
    signal: AbortSignal.timeout(2000),
    redirectUri: REDIRECT,
  };
}

beforeEach(() => {
  setup();
  meter = {
    reserve: vi.fn<QuotaMeter['reserve']>(async (r) => ({ callKey: 'k', units: r.units })),
    settle: vi.fn<QuotaMeter['settle']>(async () => {}),
  };
  cfg = {
    clientId: CLIENT.clientId,
    clientSecret: new Secret(CLIENT.clientSecret),
    projectQuota: meter,
  };
});

const exchange = (code: string, c: YouTubeConnectorConfig = cfg) =>
  exchangeCode(c, now, { code: new Secret(code), codeVerifier: new Secret('v'.repeat(43)) }, ctx);

describe('buildAuthorizationUrl', () => {
  it('authorization url has offline access, consent prompt, S256 and the force-ssl scope', () => {
    const u = buildAuthorizationUrl(cfg, {
      state: 's'.repeat(43),
      codeChallenge: 'c'.repeat(43),
      redirectUri: REDIRECT,
      scopes: [YOUTUBE_SCOPE_SHORT],
    });
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      scope: YOUTUBE_SCOPE_URL,
      state: 's'.repeat(43),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
    });
    expect(u.href).not.toContain(CLIENT.clientSecret);
  });

  it('never sends a scope it does not know', () => {
    const u = buildAuthorizationUrl(cfg, {
      state: 's',
      codeChallenge: 'c',
      redirectUri: REDIRECT,
      scopes: [YOUTUBE_SCOPE_SHORT, 'https://evil.test/scope'],
    });
    expect(u.searchParams.get('scope')).toBe(YOUTUBE_SCOPE_URL);
  });
});

describe('exchangeCode', () => {
  it('exchange maps scopes to youtube.force-ssl', async () => {
    const code = fake.authorize({
      scopes: [YOUTUBE_SCOPE_URL, 'openid', 'https://www.googleapis.com/auth/userinfo.email'],
    });
    const { tokens } = await exchange(code);
    expect([...tokens.scopes]).toEqual([YOUTUBE_SCOPE_SHORT]);
    expect(tokens.accessToken.reveal()).toMatch(/^ya29\./);
    expect(tokens.refreshToken?.reveal()).toMatch(/^1\/\//);
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(NOW + 3599_000));
    expect(tokens.refreshTokenExpiresAt).toBeNull();
    const call = seen[0]!;
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'v'.repeat(43),
      redirect_uri: REDIRECT,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
  });

  it('a grant without the scope yields no scope names (missing_permissions upstream)', async () => {
    const { tokens } = await exchange(fake.authorize({ scopes: ['openid'] }));
    expect([...tokens.scopes]).toEqual([]);
  });

  it('a reused code is auth_expired and the error carries no secret', async () => {
    const code = fake.authorize();
    await exchange(code);
    const err: unknown = await exchange(code).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth_expired', code: 'refresh_token_revoked' });
    expect(JSON.stringify(err) + String(err)).not.toContain(CLIENT.clientSecret);
  });

  it('a wrong client secret is permanent', async () => {
    const bad = { ...cfg, clientSecret: new Secret('GOCSPX-WRONG-000000000') };
    await expect(exchange(fake.authorize(), bad)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'oauth_token_rejected',
    });
  });

  it('a token response without a refresh token is refused', async () => {
    const http = createSafeHttp({
      allowedHosts: API_HOSTS,
      fetch: async () =>
        Response.json({ access_token: 'ya29.x', expires_in: 3599, scope: YOUTUBE_SCOPE_URL }),
    });
    await expect(
      exchangeCode(
        cfg,
        now,
        { code: new Secret('c'), codeVerifier: new Secret('v') },
        { ...ctx, http },
      ),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'refresh_token_missing' });
  });

  it('a 5xx from the token endpoint is transient', async () => {
    const http = createSafeHttp({
      allowedHosts: API_HOSTS,
      fetch: async () => new Response('SECRET123', { status: 503 }),
    });
    const err: unknown = await exchangeCode(
      cfg,
      now,
      { code: new Secret('c'), codeVerifier: new Secret('v') },
      { ...ctx, http },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'transient', code: 'platform_unavailable' });
    expect(String(err)).not.toContain('SECRET123');
  });
});

describe('refreshTokens', () => {
  it('returns a new access token and keeps the stored refresh token', async () => {
    const { tokens } = await exchange(fake.authorize());
    const next = await refreshTokens(cfg, now, tokens.refreshToken!, ctx);
    expect(next.accessToken.reveal()).not.toBe(tokens.accessToken.reveal());
    expect(next.refreshToken).toBeNull();
    expect([...next.scopes]).toEqual([YOUTUBE_SCOPE_SHORT]);
    expect(Object.fromEntries(new URLSearchParams(seen[1]!.body))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken!.reveal(),
    });
  });

  it('invalid_grant on refresh maps to refresh_token_revoked', async () => {
    await expect(refreshTokens(cfg, now, new Secret('1//unknown'), ctx)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'refresh_token_revoked',
      reauthorize: false,
    });
  });
});

describe('revoke', () => {
  it('posts the token in a form body to the revoke endpoint', async () => {
    const { tokens } = await exchange(fake.authorize());
    await revoke(ctx, tokens.accessToken);
    const call = seen.at(-1)!;
    expect(call.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(call.body).get('token')).toBe(tokens.accessToken.reveal());
  });

  it('an unknown token is a permanent error without the token in it', async () => {
    const err: unknown = await revoke(ctx, new Secret('ya29.gone')).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent' });
    expect(String(err)).not.toContain('ya29.gone');
  });
});

describe('listAccounts', () => {
  it('listAccounts returns the channel and charges 1 connect unit', async () => {
    const { tokens } = await exchange(fake.authorize());
    const accounts = await listAccounts(cfg, tokens.accessToken, ctx);
    expect(accounts).toEqual([
      {
        externalAccountId: CHANNEL,
        displayName: 'My channel',
        eligible: true,
        ineligibleReason: null,
        limitations: [],
        accessToken: tokens.accessToken,
      },
    ]);
    expect(meter.reserve).toHaveBeenCalledWith({
      method: 'channels.list',
      units: 1,
      purpose: 'connect',
    });
    expect(meter.settle).toHaveBeenCalledWith({ callKey: 'k', units: 1 }, { ok: true });
    const list = fake.calls.filter((c) => c.method === 'channels.list');
    expect(list).toEqual([
      { method: 'channels.list', query: { mine: 'true', part: 'snippet' }, units: 1 },
    ]);
  });

  it('listAccounts drops a channel with a malformed id as ineligible', async () => {
    setup({ id: 'UC../../evil', title: 'Evil' });
    const { tokens } = await exchange(fake.authorize());
    await expect(listAccounts(cfg, tokens.accessToken, ctx)).resolves.toEqual([]);
  });

  it('truncates the title to 200 code points', async () => {
    setup({ id: CHANNEL, title: '😀'.repeat(300) });
    const { tokens } = await exchange(fake.authorize());
    const [a] = await listAccounts(cfg, tokens.accessToken, ctx);
    expect([...a!.displayName!]).toHaveLength(200);
  });

  it('refuses to call unmetered', async () => {
    const { tokens } = await exchange(fake.authorize());
    const unmetered: YouTubeConnectorConfig = {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    };
    await expect(listAccounts(unmetered, tokens.accessToken, ctx)).rejects.toMatchObject({
      code: 'quota_meter_required',
    });
    expect(fake.calls.filter((c) => c.method === 'channels.list')).toEqual([]);
  });
});
