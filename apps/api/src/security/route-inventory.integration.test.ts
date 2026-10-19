import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { ROUTES } from '../auth/auth-proxy.controller.js';
import { startTestApi, type TestApi } from '../testing/harness.js';
import { nestHandlers as discoverHandlers } from './nest-handlers.js';
import { CAPABILITY } from '../tenancy/capability.decorator.js';
import {
  ACCOUNT_ROUTES,
  CASES,
  PROXY_ROUTES,
  PUBLIC_ROUTES,
  TOKEN_CASES,
} from './isolation-cases.js';

const FACEBOOK = {
  appId: '1112223334',
  appSecret: new Secret('fb-app-secret-0123456789abcdef'),
  graphVersion: 'v26.0',
  webhookVerifyToken: new Secret('verify-token-0123456789'),
};
// A route may have several cases (e.g. one per platform); each is listed once.
const COVERED_ROUTES = [...new Set(CASES.map((c) => c.route))];

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi({ facebook: FACEBOOK, instagram: { meta: FACEBOOK } });
});
afterAll(() => api.close());

// "METHOD /path" for every registered route, from Fastify's printed radix tree
// (4 columns per level); HEAD companions of GET are dropped. Routes that share a
// parameter position under different names print as ":a|:b"; each such route is
// resolved to the one name its Nest handler declares, so a typo still fails.
function registered(): string[] {
  const printed = api.app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false });
  const declared = new Set(nestHandlers().map((h) => h.route));
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of printed.split('\n')) {
    const m = /^((?:[│ ]   )*)[├└]── (\S+) \(([A-Z, ]+)\)$/.exec(line);
    if (!m) continue;
    stack.length = m[1]!.length / 4;
    stack.push(m[2]!);
    const path = stack.join('');
    for (const method of m[3]!.split(', ')) {
      if (method === 'HEAD') continue;
      const route = `${method} ${path}`;
      const candidates = expand(route).filter((r) => declared.has(r));
      routes.push(route.includes('|') && candidates.length === 1 ? candidates[0]! : route);
    }
  }
  return routes;
}

/** All readings of a printed route whose segments may hold ":a|:b" alternatives. */
function expand(route: string): string[] {
  const m = /:[A-Za-z]+(?:\|:[A-Za-z]+)+/.exec(route);
  if (!m) return [route];
  return m[0]
    .split('|')
    .flatMap((alt) => expand(route.slice(0, m.index) + alt + route.slice(m.index + m[0].length)));
}

const nestHandlers = () => discoverHandlers(api.app);

describe('route inventory', () => {
  it('every /api/v1 route is tenant-scoped (covered), a known account route or a signed public route', () => {
    const v1 = registered().filter((r) => r.includes(' /api/v1/'));
    expect(v1.sort()).toEqual([...COVERED_ROUTES, ...ACCOUNT_ROUTES, ...PUBLIC_ROUTES].sort());
  });

  it('exactly the public routes skip the Origin check', async () => {
    // A state-changing request from a foreign origin must be refused before any
    // handler runs; only the signature-verified webhook routes are exempt.
    const exempt: string[] = [];
    for (const route of registered()) {
      const [method, path] = route.split(' ') as [string, string];
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) continue; // never origin-checked
      const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const r = await api.req(method, url.replace(/\*$/, 'x'), {
        body: '{}',
        headers: { origin: 'https://evil.example' },
      });
      if (r.body?.error?.code !== 'invalid_origin') exempt.push(route);
    }
    // The /v1 routes authenticate by bearer key and never read cookies, so they
    // skip the check too; they are pinned separately to the registered /v1 routes.
    expect(exempt.filter((r) => !r.includes(' /v1/')).sort()).toEqual(
      PUBLIC_ROUTES.filter((r) => r.startsWith('POST ')).sort(),
    );
    expect(exempt.filter((r) => r.includes(' /v1/')).sort()).toEqual(
      registered()
        .filter((r) => r.includes(' /v1/') && !r.startsWith('GET '))
        .sort(),
    );
  });

  it('every invitation token route has a cross-organization case', () => {
    const tokenRoutes = ACCOUNT_ROUTES.filter((r) => r.includes(' /api/v1/invitations/'));
    expect(TOKEN_CASES.map((c) => c.route).sort()).toEqual(tokenRoutes.sort());
  });

  it('every tenant handler (path contains :orgId) declares @RequireCapability', () => {
    const tenant: string[] = [];
    const offenders: string[] = [];
    for (const h of nestHandlers()) {
      const [, full] = h.route.split(' ') as [string, string];
      if (!full.startsWith('/api/v1/') || !full.includes(':orgId')) continue;
      tenant.push(h.label);
      if (new Reflector().get<unknown>(CAPABILITY, h.handler) === undefined)
        offenders.push(h.label);
    }
    expect(tenant.length, 'no tenant handlers discovered').toBe(COVERED_ROUTES.length);
    expect(offenders, 'handlers without @RequireCapability').toEqual([]);
  });

  it('the /api/auth proxy allowlist is exactly the audited endpoints', () => {
    expect(Object.keys(ROUTES).sort()).toEqual([...PROXY_ROUTES].sort());
  });

  it('nothing is registered outside /api/v1 and /v1 except health and the catch-all that serves the proxy', () => {
    const other = registered().filter(
      (r) => !r.includes(' /api/v1/') && !r.includes(' /v1/') && !r.endsWith(' *'),
    );
    expect(other.sort()).toEqual(['GET /healthz', 'GET /livez']);
  });

  it('other Better Auth endpoints are not reachable through the proxy', async () => {
    for (const [method, path] of [
      ['GET', '/api/auth/list-sessions'],
      ['POST', '/api/auth/sign-up/email'],
      ['POST', '/api/auth/revoke-sessions'],
      ['POST', '/api/auth/update-user'],
      ['GET', '/api/auth/get-session'],
    ] as const) {
      const r = await api.req(method, path, { body: method === 'POST' ? {} : undefined });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });
});
