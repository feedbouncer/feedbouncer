#!/usr/bin/env node
// End-to-end auth smoke through the web origin (Next.js rewrites -> API).
// Needs a running Compose stack and Mailpit's API (the stack's mail UI port).
// Dev/CI only: it creates a throwaway account and organization.
//
// Environment (all optional):
//   SMOKE_WEB_URL      where to reach the web app   (default http://127.0.0.1:$WEB_HOST_PORT or :3000)
//   SMOKE_MAILPIT_URL  Mailpit's HTTP API           (default http://127.0.0.1:$MAILPIT_UI_HOST_PORT or :8025)
//   SMOKE_ORIGIN       the stack's PUBLIC_WEB_URL   (default http://localhost:$WEB_HOST_PORT or :3000)
import { randomUUID } from 'node:crypto';

// Read through a local alias: these are not turbo task inputs.
const env = process.env;
const webPort = env.WEB_HOST_PORT || '3000';
const WEB = env.SMOKE_WEB_URL ?? `http://127.0.0.1:${webPort}`;
const MAILPIT = env.SMOKE_MAILPIT_URL ?? `http://127.0.0.1:${env.MAILPIT_UI_HOST_PORT || '8025'}`;
const ORIGIN = env.SMOKE_ORIGIN ?? `http://localhost:${webPort}`;
const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
const password = 'smoke test passphrase that is long 42';

const request = (path, { method = 'GET', body, cookie, origin = ORIGIN } = {}) =>
  fetch(`${WEB}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { origin }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const post = (path, body, cookie, origin) =>
  request(path, { method: 'POST', body, cookie, origin });

function fail(msg) {
  console.error(`auth smoke: ${msg}`);
  process.exit(1);
}
function expectStatus(res, status, what) {
  if (res.status !== status) fail(`${what}: expected ${status}, got ${res.status}`);
  console.log(`ok - ${what}`);
}
async function expectError(res, status, code, what) {
  expectStatus(res, status, what);
  const body = await res.json();
  if (body?.error?.code !== code) fail(`${what}: expected error code ${code}`);
}

async function mailLink(to) {
  for (let i = 0; i < 40; i += 1) {
    const q = encodeURIComponent(`to:${to}`);
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${q}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
      const url = /https?:\/\/[^\s"<>]+/.exec(msg.Text ?? '')?.[0];
      if (url) return new URL(url);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail(`no email arrived for ${to}`);
}

let res = await post('/api/v1/auth/sign-up', { email, password, name: 'Smoke' });
expectStatus(res, 202, 'sign-up is accepted');

// Logging in before verification works, but creating an organization does not.
res = await post('/api/auth/sign-in/email', { email: email.toUpperCase(), password });
expectStatus(res, 200, 'sign-in (case-insensitive email)');
const cookie = res.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
if (!cookie) fail('sign-in set no session cookie');
res = await post('/api/v1/orgs', { name: 'Smoke Org', brandName: 'Smoke Brand' }, cookie);
await expectError(res, 403, 'email_not_verified', 'unverified user cannot create an organization');

// The link in the email points at PUBLIC_WEB_URL; follow its path through the web origin.
const verify = await mailLink(email);
res = await request(`${verify.pathname}${verify.search}`);
expectStatus(res, 302, 'verification link redirects');
if (res.headers.get('location') !== '/verified') fail('verification did not succeed');

res = await post('/api/v1/orgs', { name: 'Smoke Org', brandName: 'Smoke Brand' }, cookie);
expectStatus(res, 201, 'verified user creates an organization');
const { organization } = await res.json();
if (!organization?.id) fail('create organization returned no id');

res = await request(`/api/v1/orgs/${organization.id}/brands`, { cookie });
expectStatus(res, 200, 'list brands');
if ((await res.json()).brands?.length !== 1) fail('expected exactly one brand');

res = await request('/api/v1/me', { cookie });
expectStatus(res, 200, 'current user');
const me = await res.json();
if (me.memberships?.[0]?.role !== 'owner') fail('creator is not the owner');

res = await post('/api/v1/orgs', { name: 'x' }, cookie.replace(/=[^;]+/, '=forged'));
await expectError(res, 401, 'unauthenticated', 'forged session cookie is refused');

res = await post('/api/v1/orgs', { name: 'x' }, cookie, 'https://evil.test');
await expectError(res, 403, 'invalid_origin', 'cross-site POST is refused');

res = await post('/api/auth/sign-out', {}, cookie);
expectStatus(res, 200, 'sign-out');
res = await request('/api/v1/me', { cookie });
expectStatus(res, 401, 'signed-out session no longer works');

console.log('auth smoke: ok');
