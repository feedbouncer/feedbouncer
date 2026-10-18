import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlaggedItemResource, PgApiKeys, routeSpec } from '@feedbouncer/public-api';
import {
  orgWithRoles,
  startTestApi,
  type OrgFixture,
  type TestApi,
  type TestResponse,
} from '../testing/harness.js';

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let aToken: string;
let ipCounter = 0;

interface Scope {
  brandId: string;
  connectionId: string;
  sourceId: string;
}

async function scopeOf(org: OrgFixture): Promise<Scope> {
  const { scope } = await api.seedFacebookConnection(org);
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [org.orgId, scope.brandId, scope.connectionId, `post-${randomUUID()}`],
  );
  return { brandId: scope.brandId, connectionId: scope.connectionId, sourceId: source.rows[0].id };
}

interface SeedOptions {
  state?: 'visible' | 'deleted';
  createdAt?: string;
  resolved?: boolean;
}

async function seed(
  org: OrgFixture,
  s: Scope,
  o: SeedOptions = {},
): Promise<{ itemId: string; commentId: string }> {
  const comment = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          platform_state, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'hello', $6, now()) RETURNING id`,
    [org.orgId, s.brandId, s.connectionId, s.sourceId, `c-${randomUUID()}`, o.state ?? 'visible'],
  );
  const commentId = comment.rows[0].id as string;
  const item = await api.pool.query(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, created_at)
     VALUES ($1, $2, $3, $4, 'user', $5) RETURNING id`,
    [org.orgId, s.brandId, s.connectionId, commentId, o.createdAt ?? new Date().toISOString()],
  );
  const itemId = item.rows[0].id as string;
  if (o.resolved) {
    await api.pool.query(
      `UPDATE review_item SET status = 'resolved', resolution = 'dismissed', resolved_at = now()
        WHERE id = $1`,
      [itemId],
    );
  }
  return { itemId, commentId };
}

async function archivedScope(): Promise<Scope> {
  const brand = await api.pool.query(
    `INSERT INTO brand (organization_id, name) VALUES ($1, 'soon archived') RETURNING id`,
    [A.orgId],
  );
  return scopeOf({ ...A, brandId: brand.rows[0].id });
}

const get = (url: string, token = aToken): Promise<TestResponse> =>
  api.req('GET', url, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `203.0.114.${++ipCounter}` },
  });

const ids = (r: TestResponse): string[] => r.body.data.map((c: { id: string }) => c.id);

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  A = await orgWithRoles(api, 'flgA');
  B = await orgWithRoles(api, 'flgB');
  const created = await new PgApiKeys(api.pool).create(A.orgId, A.owner.userId, {
    name: 'reader',
    scope: 'read',
  });
  aToken = created.token.reveal();
});
afterAll(() => api.close());

describe('GET /v1/flagged-items', () => {
  it("returns only the key's organization, open by default, matching the spec", async () => {
    const sa = await scopeOf(A);
    const sb = await scopeOf(B);
    const open = await seed(A, sa);
    await seed(A, sa, { resolved: true });
    const other = await seed(B, sb);
    const r = await get(`/v1/flagged-items?brandId=${sa.brandId}`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([open.itemId]);
    expect(ids(await get('/v1/flagged-items?limit=100'))).not.toContain(other.itemId);
    routeSpec('listFlaggedItems').responses[200]!.parse(r.body);
    for (const item of r.body.data) FlaggedItemResource.parse(item);
    expect(r.body.data[0]).toMatchObject({
      status: 'open',
      commentId: open.commentId,
      comment: { id: open.commentId, status: 'flagged', flagged: true },
    });
  });

  it('filters status=resolved and by created range', async () => {
    const s = await scopeOf(A);
    const open = await seed(A, s, { createdAt: '2026-05-01T00:00:00Z' });
    const done = await seed(A, s, { resolved: true, createdAt: '2026-05-02T00:00:00Z' });
    const resolved = await get(
      `/v1/flagged-items?status=resolved&brandId=${s.brandId}&createdFrom=2026-05-01T00:00:00Z&createdTo=2026-06-01T00:00:00Z`,
    );
    expect(ids(resolved)).toEqual([done.itemId]);
    expect(resolved.body.data[0]).toMatchObject({ status: 'resolved', resolution: 'dismissed' });
    expect(resolved.body.data[0].resolvedAt).toEqual(expect.any(String));
    expect(resolved.body.data[0].comment.status).toBe('visible');
    const ranged = await get(
      `/v1/flagged-items?brandId=${s.brandId}&createdFrom=2026-05-01T00:00:00Z&createdTo=2026-05-02T00:00:00Z`,
    );
    expect(ids(ranged)).toEqual([open.itemId]);
  });

  it('rejects bad parameters', async () => {
    for (const q of [
      'status=all',
      'limit=101',
      'brandId=nope',
      'sort=asc',
      'createdFrom=2026-05-02T00:00:00Z&createdTo=2026-05-01T00:00:00Z',
      'createdFrom=yesterday',
    ]) {
      const r = await get(`/v1/flagged-items?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code, q).toBe('invalid_request');
    }
  });

  it('answers 401 without a key', async () => {
    expect((await api.req('GET', '/v1/flagged-items')).status).toBe(401);
  });

  it('pages without duplicates while an item is inserted between pages', async () => {
    const s = await scopeOf(A);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push((await seed(A, s, { createdAt: `2027-01-0${i + 1}T00:00:00.000Z` })).itemId);
    }
    const q = `brandId=${s.brandId}&limit=2&createdFrom=2027-01-01T00:00:00Z&createdTo=2027-03-01T00:00:00Z`;
    const p1 = await get(`/v1/flagged-items?${q}`);
    expect(ids(p1)).toEqual([made[4], made[3]]);
    const newer = await seed(A, s, { createdAt: '2027-02-01T00:00:00.000Z' });
    const p2 = await get(`/v1/flagged-items?${q}&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([made[2], made[1]]);
    const p3 = await get(`/v1/flagged-items?${q}&cursor=${p2.body.nextCursor}`);
    expect(ids(p3)).toEqual([made[0]]);
    expect(p3.body.nextCursor).toBeNull();
    const union = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(new Set(union).size).toBe(union.length);
    expect(union).not.toContain(newer.itemId);
  });

  it('rejects a cursor reused with other filters', async () => {
    const s = await scopeOf(A);
    await seed(A, s);
    await seed(A, s);
    const page = await get(`/v1/flagged-items?brandId=${s.brandId}&limit=1`);
    const reused = await get(
      `/v1/flagged-items?brandId=${s.brandId}&status=resolved&limit=1&cursor=${page.body.nextCursor}`,
    );
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('invalid_cursor');
  });

  it('embeds comment null for a deleted comment and skips archived brands', async () => {
    const s = await archivedScope();
    const gone = await seed(A, s, { state: 'deleted' });
    const r = await get(`/v1/flagged-items?brandId=${s.brandId}`);
    expect(r.body.data[0]).toMatchObject({ id: gone.itemId, comment: null });
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [s.brandId]);
    expect(ids(await get(`/v1/flagged-items?brandId=${s.brandId}`))).toEqual([]);
  });
});

describe('GET /v1/flagged-items/{id}', () => {
  it('returns the item with its flagged comment, matching the schema', async () => {
    const s = await scopeOf(A);
    const { itemId, commentId } = await seed(A, s);
    const r = await get(`/v1/flagged-items/${itemId}`);
    expect(r.status).toBe(200);
    expect(routeSpec('getFlaggedItem').responses[200]!.parse(r.body)).toMatchObject({
      id: itemId,
      status: 'open',
      comment: { id: commentId, status: 'flagged' },
    });
  });

  it('returns comment null when the comment was deleted on the platform', async () => {
    const { itemId } = await seed(A, await scopeOf(A), { state: 'deleted' });
    const r = await get(`/v1/flagged-items/${itemId}`);
    expect(r.status).toBe(200);
    expect(r.body.comment).toBeNull();
    FlaggedItemResource.parse(r.body);
  });

  it('answers 404 for another organization, an archived brand and a bad id', async () => {
    const { itemId: bId } = await seed(B, await scopeOf(B));
    const sa = await archivedScope();
    const { itemId: archived } = await seed(A, sa);
    await api.pool.query('UPDATE brand SET archived_at = now() WHERE id = $1', [sa.brandId]);
    for (const id of [bId, archived, randomUUID(), 'not-a-uuid']) {
      const r = await get(`/v1/flagged-items/${id}`);
      expect(r.status, id).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });
});
