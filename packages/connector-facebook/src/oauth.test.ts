import { describe, expect, it, vi } from 'vitest';
import { createSafeHttp } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FACEBOOK_SCOPES, type FacebookConfig } from './config.js';
import { buildAuthorizationUrl, exchangeCode, listAccounts } from './oauth.js';

const cfg: FacebookConfig = {
  appId: '111',
  appSecret: new Secret('APP-SECRET'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('v'.repeat(24)),
};
const now = () => Date.parse('2026-10-13T10:00:00Z');

function graph(routes: Record<string, (url: URL, init: RequestInit) => unknown>, status = 200) {
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const key = `${init.method} ${url.pathname}`;
    const h = routes[key];
    if (!h) {
      return new Response(JSON.stringify({ error: { code: 100, error_subcode: 33 } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(h(url, init)), { status });
  });
  return {
    fetch,
    ctx: {
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
      signal: AbortSignal.timeout(1000),
      redirectUri: 'https://app.test/api/v1/oauth/facebook/callback',
    },
  };
}

describe('buildAuthorizationUrl', () => {
  it('builds the v26.0 dialog URL with state, S256 challenge, scopes and rerequest', () => {
    const u = buildAuthorizationUrl(cfg, {
      state: 's'.repeat(43),
      codeChallenge: 'c'.repeat(43),
      redirectUri: 'https://app.test/cb',
      scopes: FACEBOOK_SCOPES,
    });
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '111',
      redirect_uri: 'https://app.test/cb',
      state: 's'.repeat(43),
      response_type: 'code',
      scope: FACEBOOK_SCOPES.join(','),
      auth_type: 'rerequest',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
  });
});

describe('exchangeCode', () => {
  it('exchanges code -> short token -> long-lived token, reads id and granted permissions', async () => {
    const forms: string[] = [];
    const { fetch, ctx } = graph({
      'POST /v26.0/oauth/access_token': (_u, init) => {
        forms.push(String(init.body));
        return String(init.body).includes('grant_type=fb_exchange_token')
          ? { access_token: 'LONG-USER-TOKEN', token_type: 'bearer', expires_in: 5_184_000 }
          : { access_token: 'SHORT-USER-TOKEN', token_type: 'bearer', expires_in: 3600 };
      },
      'GET /v26.0/me': () => ({ id: '555', name: 'Dana' }),
      'GET /v26.0/me/permissions': () => ({
        data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_messaging', status: 'declined' },
          { permission: 'public_profile', status: 'granted' },
        ],
      }),
    });
    const r = await exchangeCode(
      cfg,
      now,
      { code: new Secret('CODE-SENTINEL'), codeVerifier: new Secret('VERIFIER') },
      ctx,
    );
    expect(r.account).toEqual({ externalAccountId: '555', displayName: 'Dana' });
    expect(r.tokens.accessToken.reveal()).toBe('LONG-USER-TOKEN');
    expect(r.tokens.accessTokenExpiresAt?.toISOString()).toBe('2026-12-12T10:00:00.000Z');
    expect(r.tokens.refreshToken).toBeNull();
    expect(r.tokens.scopes).toEqual(['pages_show_list', 'public_profile']);
    expect(forms[0]).toContain('code=CODE-SENTINEL');
    expect(forms[0]).toContain('code_verifier=VERIFIER');
    expect(forms[0]).toContain('client_secret=APP-SECRET');
    for (const [url] of fetch.mock.calls) {
      expect(String(url)).not.toMatch(/SENTINEL|APP-SECRET|USER-TOKEN/);
    }
  });

  it('maps an OAuth error from the exchange to permanent/graph_error without the message', async () => {
    const { ctx } = graph(
      {
        'POST /v26.0/oauth/access_token': () => ({
          error: { code: 100, message: 'Invalid verification code CODE' },
        }),
      },
      400,
    );
    const err = await exchangeCode(
      cfg,
      now,
      { code: new Secret('bad'), codeVerifier: new Secret('v') },
      ctx,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'graph_error' });
    expect(String((err as Error).message)).not.toContain('Invalid verification code');
  });
});

describe('listAccounts', () => {
  it('lists pages with eligibility from tasks and follows paging within the allowed host', async () => {
    const { ctx } = graph({
      'GET /v26.0/me/accounts': (u) =>
        u.searchParams.get('after') === 'CUR2'
          ? {
              data: [{ id: '103', name: 'Third', tasks: ['ANALYZE'], access_token: 'PT3' }],
              paging: {},
            }
          : {
              data: [
                {
                  id: '101',
                  name: 'Shop',
                  tasks: ['MODERATE', 'MESSAGING', 'CREATE_CONTENT'],
                  access_token: 'PT1',
                },
                { id: '102', name: 'Blog', tasks: ['MODERATE'], access_token: 'PT2' },
              ],
              paging: {
                cursors: { after: 'CUR2' },
                next: 'https://graph.facebook.com/v26.0/me/accounts?after=CUR2',
              },
            },
    });
    const pages = await listAccounts(cfg, now, new Secret('LONG-USER-TOKEN'), ctx);
    expect(
      pages.map((p) => [
        p.externalAccountId,
        p.eligible,
        p.ineligibleReason,
        p.limitations,
        p.accessToken.reveal(),
      ]),
    ).toEqual([
      ['101', true, null, [], 'PT1'],
      ['102', true, null, ['no_messaging_task'], 'PT2'],
      ['103', false, 'insufficient_page_role', ['no_messaging_task'], 'PT3'],
    ]);
  });

  it('drops entries with hostile ids or missing tokens instead of failing the whole list', async () => {
    const { ctx } = graph({
      'GET /v26.0/me/accounts': () => ({
        data: [
          { id: '../me', name: 'x', tasks: ['MODERATE'], access_token: 'T' },
          { id: '104', name: 'NoToken', tasks: ['MODERATE'] },
          { id: '105', name: 'Ok', tasks: ['MODERATE', 'MESSAGING'], access_token: 'T5' },
        ],
      }),
    });
    expect(
      (await listAccounts(cfg, now, new Secret('U'), ctx)).map((p) => p.externalAccountId),
    ).toEqual(['105']);
  });
});
