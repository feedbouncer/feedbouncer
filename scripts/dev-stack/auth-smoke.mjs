#!/usr/bin/env node
// End-to-end auth smoke through the web origin (Next.js route handlers -> API).
// Needs a running Compose stack and Mailpit's API (the stack's mail UI port).
// Reads auth_session through `docker compose exec postgres`, so run it from the
// repository root with the stack's COMPOSE_PROJECT_NAME (and .env) in effect.
// Dev/CI only: it creates a throwaway account and organization.
//
// Environment (all optional):
//   SMOKE_WEB_URL      where to reach the web app   (default http://127.0.0.1:$WEB_HOST_PORT or :3000)
//   SMOKE_MAILPIT_URL  Mailpit's HTTP API           (default http://127.0.0.1:$MAILPIT_UI_HOST_PORT or :8025)
//   SMOKE_ORIGIN       the stack's PUBLIC_WEB_URL   (default http://localhost:$WEB_HOST_PORT or :3000)
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Read through a local alias: these are not turbo task inputs.
const env = process.env;
const webPort = env.WEB_HOST_PORT || '3000';
const WEB = env.SMOKE_WEB_URL ?? `http://127.0.0.1:${webPort}`;
const MAILPIT = env.SMOKE_MAILPIT_URL ?? `http://127.0.0.1:${env.MAILPIT_UI_HOST_PORT || '8025'}`;
const ORIGIN = env.SMOKE_ORIGIN ?? `http://localhost:${webPort}`;
const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
const password = 'smoke test passphrase that is long 42';

const request = (path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) =>
  fetch(`${WEB}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...headers,
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

const compose = (args, input) =>
  execFileSync('docker', ['compose', ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    timeout: 30_000,
  })
    .split('\n')
    .filter(Boolean);

// The client address the API recorded for each of this user's sessions.
function sessionIps() {
  if (!/^smoke-[0-9a-f]{8}@example\.test$/.test(email)) fail('unexpected smoke email');
  const psql = 'exec psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"';
  try {
    return compose(
      ['exec', '-T', 'postgres', 'sh', '-c', psql],
      `SELECT s.ip_address FROM auth_session s JOIN app_user u ON u.id = s.user_id
        WHERE u.email = '${email}' ORDER BY s.created_at;`,
    );
  } catch {
    return fail('could not read sessions with docker compose exec postgres');
  }
}

// The web container's own addresses: the API seeing one of these means every
// browser shares a single per-IP budget.
function webAddresses() {
  const js =
    "console.log(Object.values(require('os').networkInterfaces()).flat().map((i) => i.address).join('\\n'))";
  try {
    return compose(['exec', '-T', 'web', 'node', '-e', js]);
  } catch {
    return fail('could not read the web container addresses with docker compose exec web');
  }
}

async function mailLink(to, subject) {
  for (let i = 0; i < 40; i += 1) {
    const q = encodeURIComponent(`to:${to} subject:"${subject}"`);
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

// Per-IP limits key on the address the web server saw, never on one the client claims.
const SPOOFED = '203.0.113.99';
res = await request('/api/auth/sign-in/email', {
  method: 'POST',
  body: { email, password },
  headers: { 'x-forwarded-for': SPOOFED, 'x-real-ip': SPOOFED, forwarded: `for=${SPOOFED}` },
});
expectStatus(res, 200, 'sign-in with a client-supplied X-Forwarded-For');
const ips = sessionIps();
if (ips.length !== 2 || ips[0] !== ips[1] || ips.includes(SPOOFED)) {
  fail('the API did not record the web-observed client address for both sessions');
}
if (webAddresses().includes(ips[0])) fail('the API saw the web server, not the client');
console.log('ok - a client-supplied X-Forwarded-For is ignored');
res = await post('/api/v1/orgs', { name: 'Smoke Org', brandName: 'Smoke Brand' }, cookie);
await expectError(res, 403, 'email_not_verified', 'unverified user cannot create an organization');

// The link in the email points at PUBLIC_WEB_URL; follow its path through the web origin.
const verify = await mailLink(email, 'Confirm your email');
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

// Forgot password: the emailed link opens the web reset page, which posts its token.
res = await post('/api/auth/request-password-reset', { email });
expectStatus(res, 200, 'password reset requested');
const reset = await mailLink(email, 'Reset your');
if (reset.origin !== new URL(ORIGIN).origin || reset.pathname !== '/reset-password') {
  fail('reset link is not the web reset page');
}
const resetToken = reset.searchParams.get('token');
if (!resetToken) fail('reset link carries no token');
res = await request(`${reset.pathname}${reset.search}`);
expectStatus(res, 200, 'reset link opens the reset page');
if (!(await res.text()).includes('Choose a new password')) fail('reset page shows no form');
const newPassword = 'a different smoke passphrase 43';
res = await post('/api/auth/reset-password', { token: resetToken, newPassword });
expectStatus(res, 200, 'password reset with the emailed token');
res = await post('/api/auth/sign-in/email', { email, password });
await expectError(res, 401, 'invalid_credentials', 'old password no longer signs in');
res = await post('/api/auth/sign-in/email', { email, password: newPassword });
expectStatus(res, 200, 'new password signs in');

console.log('auth smoke: ok');
