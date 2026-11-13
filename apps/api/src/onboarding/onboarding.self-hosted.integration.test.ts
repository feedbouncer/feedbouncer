// The whole wizard with the classifier disabled and no outbound network: the same flow a
// self-hosted install runs. There is deliberately no deployment switch to vary.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { orgWithRoles, startTestApi, type TestApi } from '../testing/harness.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi({ classifier: { id: 'fake', model: 'fake-1', enabled: false } });
});
afterAll(() => api.close());

it('runs the full wizard without any outbound network call', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('outbound network disabled');
  });
  try {
    const f = await orgWithRoles(api, 'onbsh');
    await api.seedFacebookConnection(f);
    const url = (p: string) => `/api/v1/orgs/${f.orgId}/onboarding${p}`;
    const run = async (method: string, p: string, body?: unknown) => {
      const r = await api.req(method, url(p), {
        cookie: f.owner.cookie,
        ...(body !== undefined && { body }),
      });
      expect(r.status, `${method} ${p}`).toBeGreaterThanOrEqual(200);
      expect(r.status, `${method} ${p}`).toBeLessThan(300);
      return r;
    };
    await run('GET', '');
    await run('POST', '/start', {});
    await run('POST', '/connect/complete', {});
    const g = (await run('GET', '/defaults')).body;
    expect(g.aiEnabled).toBe(false);
    await run('PUT', '/defaults', {
      choices: g.categories
        .filter((c: { action: string }) => c.action !== 'remove')
        .map((c: { category: string; action: string }) => ({
          category: c.category,
          action: c.action,
        })),
      basedOn: g.basedOn,
    });
    await run('PUT', '/review-mode', { choice: 'review' });
    await run('GET', '/report');
    const done = await run('POST', '/report/complete', {});
    expect(done.body.complete).toBe(true);
    expect((await run('GET', '')).body.complete).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
