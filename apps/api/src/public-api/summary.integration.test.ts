// GET /v1/summary.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys, routeSpec } from '@feedbouncer/public-api';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

const DAY = 86_400_000;

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let token: string;
let ipCounter = 0;

const get = (query: string, t = token) =>
  api.req('GET', `/v1/summary${query}`, {
    headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': `203.0.113.${++ipCounter}` },
  });

async function seedComments(org: OrgFixture, count: number): Promise<void> {
  const { scope } = await api.seedFacebookConnection(org);
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [org.orgId, scope.brandId, scope.connectionId, `post-${randomUUID()}`],
  );
  for (let i = 0; i < count; i++)
    await api.pool.query(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1, $2, $3, $4, $5, 'hello', now() - interval '1 day')`,
      [org.orgId, scope.brandId, scope.connectionId, source.rows[0].id, `c-${randomUUID()}`],
    );
}

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  A = await orgWithRoles(api, 'sumA');
  B = await orgWithRoles(api, 'sumB');
  await seedComments(A, 2);
  await seedComments(B, 3);
  const { token: t } = await new PgApiKeys(api.pool).create(A.orgId, A.owner.userId, {
    name: 'reader',
    scope: 'read',
  });
  token = t.reveal();
});
afterAll(() => api.close());

describe('GET /v1/summary', () => {
  it("summarizes the last 7 days of the key's organization, matching the spec", async () => {
    const r = await get('');
    expect(r.status).toBe(200);
    routeSpec('getSummary').responses[200]!.parse(r.body);
    expect(r.body.bounded).toBeNull();
    expect(r.body.totals).toEqual({ comments: 2, hidden: 0, replied: 0, unanswered: 2 });
    expect(Date.parse(r.body.period.to) - Date.parse(r.body.period.from)).toBe(7 * DAY);
  });

  it('is empty, not an error, for a range without comments', async () => {
    const r = await get('?from=2020-01-01T00:00:00Z&to=2020-01-08T00:00:00Z');
    expect(r.status).toBe(200);
    expect(r.body.totals.comments).toBe(0);
    expect(r.body.notableThreads).toEqual([]);
  });

  it('filters by one of its brands', async () => {
    const r = await get(`?brandId=${A.brandId}`);
    expect(r.status).toBe(200);
    expect(r.body.totals.comments).toBe(2);
  });

  it('answers 400 with the reason for a reversed range', async () => {
    const r = await get('?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'invalid_request', reason: 'to_before_from' });
  });

  it('answers 400 with the reason for an end in the future', async () => {
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const r = await get(`?to=${encodeURIComponent(to)}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'invalid_request', reason: 'to_in_future' });
  });

  it('bounds a 120-day range to 92 days and says so', async () => {
    const to = new Date(Date.now() - 60_000);
    const from = new Date(to.getTime() - 120 * DAY);
    const r = await get(
      `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.bounded).toEqual({
      requestedFrom: from.toISOString(),
      reason: 'max_range_92_days',
    });
    expect(Date.parse(r.body.period.to) - Date.parse(r.body.period.from)).toBe(92 * DAY);
  });

  it("answers 404 for another organization's brand, an unknown brand and a malformed one", async () => {
    expect((await get(`?brandId=${B.brandId}`)).status).toBe(404);
    expect((await get(`?brandId=${randomUUID()}`)).status).toBe(404);
    expect((await get('?brandId=nope')).status).toBe(400);
  });

  it('answers 404 for an archived brand', async () => {
    const brand = await api.pool.query(
      `INSERT INTO brand (organization_id, name, archived_at) VALUES ($1, 'Old', now()) RETURNING id`,
      [A.orgId],
    );
    expect((await get(`?brandId=${brand.rows[0].id}`)).status).toBe(404);
  });

  it('rejects a missing key', async () => {
    const r = await api.req('GET', '/v1/summary', {});
    expect(r.status).toBe(401);
  });
});
