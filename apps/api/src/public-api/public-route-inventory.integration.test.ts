import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_ROUTE_SPECS } from '@feedbouncer/public-api';
import { nestHandlers } from '../security/nest-handlers.js';
import { startTestApi, type TestApi } from '../testing/harness.js';
import { API_SCOPE } from './scope.decorator.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

const toFastify = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

describe('public route inventory', () => {
  it('registers exactly the routes of the spec table', () => {
    const expected = PUBLIC_ROUTE_SPECS.map((s) => `${s.method} ${toFastify(s.path)}`);
    const registered = nestHandlers(api.app)
      .map((h) => h.route)
      .filter((r) => r.split(' ')[1]!.startsWith('/v1/'));
    expect(registered.sort()).toEqual(expected.sort());
  });

  it('declares @RequireScope equal to the spec scope on every /v1 handler but the document route', () => {
    const specs = new Map(PUBLIC_ROUTE_SPECS.map((s) => [`${s.method} ${toFastify(s.path)}`, s]));
    const reflector = new Reflector();
    const v1 = nestHandlers(api.app).filter((h) => h.route.split(' ')[1]!.startsWith('/v1/'));
    expect(v1.length).toBe(PUBLIC_ROUTE_SPECS.length);
    for (const h of v1) {
      const spec = specs.get(h.route);
      expect(spec, `${h.label} has no route spec`).toBeDefined();
      const scope = reflector.get<string | undefined>(API_SCOPE, h.handler);
      if (spec!.id === 'getOpenApi') expect(scope, h.label).toBeUndefined();
      else expect(scope, h.label).toBe(spec!.scope);
    }
  });
});
