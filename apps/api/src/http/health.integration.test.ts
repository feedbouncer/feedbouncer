import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/harness.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

it('GET /livez is 200 {status:"ok"}', async () => {
  const r = await api.req('GET', '/livez');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: 'ok' });
  expect(r.headers['cache-control']).toBe('no-store');
});

it('GET /healthz reports postgres and redis', async () => {
  const r = await api.req('GET', '/healthz');
  expect(r.status).toBe(200);
  // Byte-for-byte what scripts/dev-stack/smoke.mjs asserts.
  expect(JSON.stringify(r.body)).toBe('{"status":"ok","checks":{"postgres":"up","redis":"up"}}');
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['x-content-type-options']).toBe('nosniff');
});

it('HEAD /livez and /healthz work', async () => {
  expect((await api.req('HEAD', '/livez')).status).toBe(200);
  expect((await api.req('HEAD', '/healthz')).status).toBe(200);
});

it('unknown routes are 404 with the error envelope', async () => {
  const r = await api.req('GET', '/nope');
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  expect(r.headers['cache-control']).toBe('no-store');
});

it('cross-site POSTs are refused before any handler', async () => {
  const r = await api.req('POST', '/api/v1/orgs', {
    body: {},
    headers: { origin: 'https://evil.test' },
  });
  expect(r.status).toBe(403);
  expect(r.body).toEqual({
    error: { code: 'invalid_origin', message: 'Request origin is not allowed.' },
  });
});

it.each([
  ['an encoded /api prefix', '/%61pi/v1/orgs'],
  ['a path outside /api', '/anything/else'],
  ['an unknown root path', '/'],
])('cross-site POSTs to %s are refused', async (_label, url) => {
  const r = await api.req('POST', url, { body: {}, headers: { origin: 'https://evil.test' } });
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('invalid_origin');
});

it('POSTs with neither Origin nor Sec-Fetch-Site are refused', async () => {
  const r = await api.req('POST', '/api/auth/sign-in/email', {
    body: {},
    headers: { origin: '' },
  });
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('invalid_origin');
});

it('text/plain bodies are rejected', async () => {
  const r = await api.req('POST', '/api/v1/orgs', {
    body: 'x',
    headers: { 'content-type': 'text/plain' },
  });
  // 404, not 415: there is no POST /api/v1/orgs route yet, and Fastify
  // resolves the route before it looks for a content-type parser. What stops a
  // text/plain body from ever being parsed is the parser removal asserted in
  // the next test; once real POST routes exist this becomes 415.
  expect(r.status).toBe(404);
  expect(r.body.error.code).toBe('not_found');
});

it('only JSON bodies are parsed (no CORS-simple content types)', () => {
  const fastify = api.app.getHttpAdapter().getInstance();
  expect(fastify.hasContentTypeParser('application/json')).toBe(true);
  expect(fastify.hasContentTypeParser('text/plain')).toBe(false);
  expect(fastify.hasContentTypeParser('application/x-www-form-urlencoded')).toBe(false);
  expect(fastify.hasContentTypeParser('multipart/form-data')).toBe(false);
});

it('form-encoded bodies are rejected', async () => {
  const r = await api.req('POST', '/api/v1/orgs', {
    body: 'name=x',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(r.status).toBe(404); // no such route yet; see the text/plain test
});

it('request logs carry the route pattern, never the URL or query string', async () => {
  api.logLines.length = 0;
  await api.req('GET', '/livez?token=SENTINEL-TOKEN');
  await api.req('GET', '/nope/SENTINEL-PATH?token=SENTINEL-TOKEN');
  const logs = api.logLines.join('\n');
  expect(logs).not.toContain('SENTINEL');
  const entries = api.logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(entries).toContainEqual(
    expect.objectContaining({ msg: 'request', method: 'GET', route: '/livez', status: 200 }),
  );
  expect(entries).toContainEqual(
    expect.objectContaining({ msg: 'request', method: 'GET', route: 'unmatched', status: 404 }),
  );
});

it('/healthz is 503 when Redis is down', async () => {
  const down = await startTestApi({ redisUrl: new URL('redis://127.0.0.1:1/0') });
  try {
    const r = await down.req('GET', '/healthz');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', redis: 'down' } });
  } finally {
    await down.close();
  }
});
