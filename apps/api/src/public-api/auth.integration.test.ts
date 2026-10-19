import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgApiKeys, type ApiKeyScope } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';
import { buildOpenApiDocument } from './openapi.js';

let api: TestApi;
let org: OrgFixture;
let keys: PgApiKeys;
beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  org = await orgWithRoles(api, 'pubauth');
  keys = new PgApiKeys(api.pool);
});
afterAll(() => api.close());

let ipCounter = 0;
/** A distinct client address per call, so the per-IP failure budget never leaks between tests. */
const freshIp = () => `203.0.113.${++ipCounter}`;
const newKey = async (scope: ApiKeyScope, name = `key-${scope}-${ipCounter++}`) => {
  const { key, token } = await keys.create(org.orgId, org.owner.userId, { name, scope });
  return { key, token: token.reveal() };
};
// A read route and a write route of the real API. Passing authentication shows up as anything but
// 401/403: the list answers 200, and hiding an unknown comment answers 404.
const route = (method: string) =>
  method === 'GET' ? '/v1/comments' : `/v1/comments/${randomUUID()}/hide`;
const PASSES = { GET: 200, POST: 404 } as const;
const call = (
  method: string,
  token: string | null,
  extra: Record<string, string> = {},
  ip = freshIp(),
) =>
  api.req(method, route(method), {
    headers: {
      'x-forwarded-for': ip,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
  });

describe('API key authentication', () => {
  it('accepts a valid read key and reports rate-limit headers', async () => {
    const { token } = await newKey('read');
    const r = await call('GET', token);
    expect(r.status).toBe(200);
    expect(r.headers['x-ratelimit-limit']).toBe('60');
    expect(r.headers['x-ratelimit-remaining']).toBe('59');
  });

  it('matches the Bearer scheme case-insensitively', async () => {
    const { token } = await newKey('read');
    const r = await call('GET', null, { authorization: `bearer ${token}` });
    expect(r.status).toBe(200);
  });

  it('answers 401 with a challenge when there is no Authorization header', async () => {
    const r = await call('GET', null);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
    expect(r.headers['www-authenticate']).toBe('Bearer realm="FeedBouncer API"');
  });

  it('rejects other schemes, malformed tokens and a dashboard session cookie', async () => {
    const basic = await call('GET', null, { authorization: 'Basic Zm9vOmJhcg==' });
    const malformed = await call('GET', 'not-a-key');
    const cookie = await api.req('GET', '/v1/comments', {
      cookie: org.owner.cookie,
      headers: { 'x-forwarded-for': freshIp() },
    });
    for (const r of [basic, malformed, cookie]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('unauthenticated');
      expect(r.headers['www-authenticate']).toBe('Bearer realm="FeedBouncer API"');
    }
  });

  it('treats a revoked key exactly like an unknown one', async () => {
    const { key, token } = await newKey('write');
    expect((await call('GET', token)).status).toBe(200);
    await keys.revoke(org.orgId, org.owner.userId, key.id);
    const revoked = await call('GET', token);
    const unknown = await call('GET', 'fbk_aaaaaaaaaaaaaaaa_' + 'A'.repeat(43));
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual(unknown.body);
  });

  it('answers 403 insufficient_scope for a read key on a write route, and lets write keys read', async () => {
    const read = await newKey('read');
    const write = await newKey('write');
    const denied = await call('POST', read.token);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');
    expect((await call('POST', write.token)).status).toBe(PASSES.POST);
    expect((await call('GET', write.token)).status).toBe(200);
  });

  it('is not subject to the dashboard Origin check', async () => {
    const { token } = await newKey('write');
    const r = await call('POST', token, { origin: 'https://evil.example' });
    expect(r.status).toBe(PASSES.POST);
  });
});

describe('rate limits', () => {
  it('limits each key to 60 requests a minute, independently of other keys', async () => {
    const a = await newKey('read');
    const b = await newKey('read');
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await call('GET', a.token, {}, ip)).status).toBe(200);
    const limited = await call('GET', a.token, {}, ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
    expect((await call('GET', b.token, {}, ip)).status).toBe(200);
  });

  it('allows 30 failed authentications a minute per address, then answers 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await call('GET', 'bad-token', {}, ip)).status).toBe(401);
    const limited = await call('GET', 'bad-token', {}, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(limited.headers['x-ratelimit-limit']).toBeUndefined();
    // Other addresses are unaffected.
    expect((await call('GET', 'bad-token')).status).toBe(401);
  });

  it('refuses an address over its failed-authentication budget before looking the key up', async () => {
    const { token } = await newKey('read');
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await call('GET', 'bad-token', {}, ip)).status).toBe(401);
    const authenticate = vi.spyOn(PgApiKeys.prototype, 'authenticate');
    try {
      const limited = await call('GET', token, {}, ip);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      authenticate.mockRestore();
    }
  });

  it('fails closed with 503 when the rate limit store is down', async () => {
    const down = await startTestApi({});
    try {
      const o = await orgWithRoles(down, 'pubdown');
      const { token } = await new PgApiKeys(down.pool).create(o.orgId, o.owner.userId, {
        name: 'k',
        scope: 'read',
      });
      expect(
        (await down.req('GET', '/v1/comments', { headers: bearer(token.reveal()) })).status,
      ).toBe(200);
      down.deps.redis.disconnect();
      const r = await down.req('GET', '/v1/comments', { headers: bearer(token.reveal()) });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('temporarily_unavailable');
    } finally {
      await down.close();
    }
  });
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('GET /v1/openapi.json', () => {
  it('is public, cacheable for five minutes and equals the generated document', async () => {
    const r = await api.req('GET', '/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});
