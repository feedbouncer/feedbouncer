// The free scan's read-only Meta OAuth leg over the API, with FakeGraph behind SafeHttp:
// authorize -> consent -> callback -> grant.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { open } from '@feedbouncer/secrets';
import { Secret } from '@feedbouncer/service-runtime';
import { WEB, startTestApi, type TestApi, type TestResponse } from '../testing/harness.js';

const SECRET = 'fb-app-secret-0123456789abcdef';
const APP_ID = '1112223334';
const FACEBOOK = {
  appId: APP_ID,
  appSecret: new Secret(SECRET),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
const SCAN_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'ads_read',
  'instagram_basic',
  'instagram_manage_comments',
];
const AUTHORIZE = '/api/v1/scan/authorize';
const CALLBACK = '/api/v1/scan/oauth/meta/callback';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sha256 = (s: string) => createHash('sha256').update(s).digest();

let api: TestApi;
let graph: FakeGraph;
let fbUserId: string;
/** Callback responses, and authorize responses (which carry the state by design). */
const seen: TestResponse[] = [];
const authorized: TestResponse[] = [];
const states: string[] = [];

beforeAll(async () => {
  graph = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
  api = await startTestApi({ facebook: FACEBOOK }, { fetch: graph.fetch });
  fbUserId = graph.addUser('Dana').userId;
  graph.addPage(fbUserId, { name: 'Acme' });
  graph.addPage(fbUserId, { name: 'Analyst only', tasks: ['ANALYZE'] });
});
afterAll(() => api.close());

// Every test may authorize; the per-IP hourly limit must not carry over.
beforeEach(async () => {
  const keys = await api.deps.redis.keys(`${api.deps.redisKeyPrefix}rl:scan_*`);
  if (keys.length) await api.deps.redis.del(...keys);
});

async function authorize(cookie?: string): Promise<TestResponse> {
  const r = await api.req('POST', AUTHORIZE, { body: {}, ...(cookie ? { cookie } : {}) });
  authorized.push(r);
  return r;
}

/** A new visitor that authorized and consented on Facebook. */
async function consented(opts: { decline?: string[] } = {}) {
  const r = await authorize();
  expect(r.status).toBe(200);
  const { code, state } = graph.consent(new URL(r.body.authorizeUrl), fbUserId, opts);
  states.push(state);
  return { cookie: r.cookie!, code, state };
}

async function callback(query: Record<string, string>, cookie?: string): Promise<string> {
  const r = await api.req('GET', `${CALLBACK}?${new URLSearchParams(query)}`, {
    ...(cookie ? { cookie } : {}),
  });
  seen.push(r);
  expect(r.status).toBe(303);
  return String(r.headers.location);
}

const grantCount = async () =>
  Number((await api.pool.query('SELECT count(*) AS n FROM scan_grant')).rows[0].n);

describe('POST /api/v1/scan/authorize', () => {
  it('refuses a request without Origin', async () => {
    const r = await api.req('POST', AUTHORIZE, { body: {}, headers: { origin: '' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('invalid_origin');
  });

  it('sets the visitor cookie and returns the Facebook dialog with exactly the scan scopes', async () => {
    const r = await authorize();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/^fb_scan_visitor=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // WEB is http
    const url = new URL(r.body.authorizeUrl);
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v26.0/dialog/oauth');
    expect(url.searchParams.get('scope')!.split(',').sort()).toEqual([...SCAN_SCOPES].sort());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`${WEB}${CALLBACK}`);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the state's hash is stored, bound to the visitor.
    const state = url.searchParams.get('state')!;
    const row = await api.pool.query(
      'SELECT visitor_id, expires_at FROM scan_oauth_state WHERE state_hash = $1',
      [sha256(state)],
    );
    expect(row.rowCount).toBe(1);
    const ttl = (row.rows[0].expires_at as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    // A known visitor keeps its cookie.
    const again = await authorize(r.cookie!);
    expect(again.status).toBe(200);
    expect(again.headers['set-cookie']).toBeUndefined();
    const visitors = await api.pool.query(
      'SELECT DISTINCT visitor_id FROM scan_oauth_state WHERE state_hash = ANY($1)',
      [[sha256(state), sha256(new URL(again.body.authorizeUrl).searchParams.get('state')!)]],
    );
    expect(visitors.rowCount).toBe(1);
  });

  it('answers the 11th authorize from one IP within an hour with 429 and retry-after', async () => {
    for (let i = 0; i < 10; i++) expect((await authorize()).status).toBe(200);
    const r = await authorize();
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /api/v1/scan/oauth/meta/callback', () => {
  it('stores a grant with the sealed user token and redirects to the page picker', async () => {
    const { cookie, code, state } = await consented();
    const location = await callback({ code, state }, cookie);
    const m = new RegExp(`^${WEB}/scan/pages/(${UUID})$`).exec(location);
    expect(m, location).not.toBeNull();
    const grantId = m![1]!;
    const { rows } = await api.pool.query(
      `SELECT g.key_id, g.encrypted_user_token, g.fb_user_hash, g.granted_scopes, g.pages,
              g.expires_at, v.token_hash
         FROM scan_grant g JOIN scan_visitor v ON v.id = g.visitor_id WHERE g.id = $1`,
      [grantId],
    );
    const g = rows[0];
    expect(g.token_hash).toEqual(sha256(cookie.split('=')[1]!));
    expect(g.fb_user_hash).toEqual(sha256(fbUserId));
    expect([...g.granted_scopes].sort()).toEqual([...SCAN_SCOPES].sort());
    expect(g.pages.map((p: { name: string; eligible: boolean }) => [p.name, p.eligible])).toEqual(
      expect.arrayContaining([
        ['Acme', true],
        ['Analyst only', false],
      ]),
    );
    const ttl = (g.expires_at as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
    const token = await open(api.deps.env.encryption, g.encrypted_user_token, {
      organizationId: 'scan-tool',
      connectionId: grantId,
      kind: 'scan_user_token',
    });
    expect(graph.issuedSecrets()).toContain(token.reveal());
    expect(Buffer.from(g.encrypted_user_token).toString('latin1')).not.toContain(token.reveal());
    // The state is single-use.
    expect(
      (
        await api.pool.query('SELECT 1 FROM scan_oauth_state WHERE state_hash = $1', [
          sha256(state),
        ])
      ).rowCount,
    ).toBe(0);
    // Only the code exchange writes; everything after it reads.
    const writes = graph.calls().filter((c) => c.method !== 'GET');
    expect(new Set(writes.map((c) => c.path))).toEqual(new Set(['oauth/access_token']));
  });

  it('refuses another visitor’s cookie, a replayed state and an expired state without a Graph call', async () => {
    const a = await consented();
    const b = await authorize();
    const before = { calls: graph.calls().length, grants: await grantCount() };
    const refused = async (query: Record<string, string>, cookie?: string) => {
      expect(await callback(query, cookie)).toBe(`${WEB}/scan?error=state_invalid`);
      expect(graph.calls().length).toBe(before.calls);
      expect(await grantCount()).toBe(before.grants);
    };

    await refused({ code: a.code, state: a.state }, b.cookie!); // foreign visitor
    await refused({ code: a.code, state: a.state }); // no cookie
    await refused({ code: a.code, state: randomBytes(32).toString('base64url') }, a.cookie);
    await refused({ code: a.code, state: 'not-a-state' }, a.cookie);
    await refused({ state: a.state }, a.cookie); // no code

    // None of the above burned A's state.
    expect(await callback({ code: a.code, state: a.state }, a.cookie)).toMatch(/\/scan\/pages\//);
    before.calls = graph.calls().length;
    before.grants = await grantCount();
    await refused({ code: a.code, state: a.state }, a.cookie); // replay

    const e = await consented();
    await api.pool.query(
      "UPDATE scan_oauth_state SET expires_at = now() - interval '1 second' WHERE state_hash = $1",
      [sha256(e.state)],
    );
    await refused({ code: e.code, state: e.state }, e.cookie);
  });

  it('maps a declined dialog to error=declined', async () => {
    const { cookie, state } = await consented();
    const calls = graph.calls().length;
    expect(
      await callback({ error: 'access_denied', error_reason: 'user_denied', state }, cookie),
    ).toBe(`${WEB}/scan?error=declined`);
    expect(graph.calls().length).toBe(calls);
  });

  it('lists only the missing required scopes, never an injected value', async () => {
    const { cookie, code, state } = await consented({ decline: ['ads_read', 'instagram_basic'] });
    const grants = await grantCount();
    const location = await callback(
      { code, state, missing: 'evil<script>,pages_manage_posts' },
      cookie,
    );
    expect(location).toBe(`${WEB}/scan?error=missing_permissions&missing=ads_read`);
    expect(await grantCount()).toBe(grants);
  });

  it('maps a transient Graph failure to error=platform_unavailable', async () => {
    const { cookie, code, state } = await consented();
    const grants = await grantCount();
    graph.failNextFor('/me/accounts', 2);
    expect(await callback({ code, state }, cookie)).toBe(`${WEB}/scan?error=platform_unavailable`);
    expect(await grantCount()).toBe(grants);
  });

  it('ignores anything but a /scan path on this origin', async () => {
    const { cookie, code, state } = await consented();
    const location = await callback(
      { code, state, redirect: 'https://evil.example', next: '//evil.example' },
      cookie,
    );
    expect(new URL(location).origin).toBe(WEB);
    expect(new URL(location).pathname).toMatch(/^\/scan\//);
  });
});

describe('secrets', () => {
  it('no response or log line carries a token, code, state or visitor cookie', () => {
    const text = (r: TestResponse) =>
      JSON.stringify(r.body) + JSON.stringify({ ...r.headers, 'set-cookie': '' });
    const cookies = authorized.flatMap((r) => (r.cookie ? [r.cookie.split('=')[1]!] : []));
    const graphSecrets = graph.issuedSecrets();
    expect(graphSecrets.length).toBeGreaterThan(5);
    for (const t of [...seen, ...authorized].map(text).concat(api.logLines))
      for (const s of graphSecrets) expect(t).not.toContain(s);
    for (const t of seen.map(text).concat(api.logLines))
      for (const s of [...states, ...cookies]) expect(t).not.toContain(s);
  });
});

describe('SCAN_TOOL_ENABLED=false', () => {
  it('answers every scan route 404 not_found', async () => {
    const g = new FakeGraph({ appSecret: SECRET, appId: APP_ID });
    const off = await startTestApi(
      {
        facebook: FACEBOOK,
        scan: { enabled: false, maxComments: 2000, retentionDays: 30, workerConcurrency: 2 },
      },
      { fetch: g.fetch },
    );
    try {
      const a = await off.req('POST', AUTHORIZE, { body: {} });
      expect(a.status).toBe(404);
      expect(a.body.error.code).toBe('not_found');
      expect(a.headers['set-cookie']).toBeUndefined();
      const c = await off.req('GET', `${CALLBACK}?code=x&state=${'a'.repeat(43)}`);
      expect(c.status).toBe(404);
      expect(c.body.error.code).toBe('not_found');
      expect(g.calls()).toEqual([]);
    } finally {
      await off.close();
    }
  });
});
