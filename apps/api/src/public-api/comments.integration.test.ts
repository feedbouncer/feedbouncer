import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys, CommentResource, routeSpec } from '@feedbouncer/public-api';
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
let scopeA: { brandId: string; connectionId: string; sourceId: string };
let scopeB: typeof scopeA;
let ipCounter = 0;

async function scopeOf(org: OrgFixture, platform: 'facebook' | 'instagram' = 'facebook') {
  const { scope } =
    platform === 'facebook'
      ? await api.seedFacebookConnection(org)
      : await api.seedConnection(org, {
          platform,
          externalAccountId: `17${String(Date.now())}${++ipCounter}`,
        });
  const source = await api.pool.query(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [org.orgId, scope.brandId, scope.connectionId, `post-${randomUUID()}`],
  );
  return { brandId: scope.brandId, connectionId: scope.connectionId, sourceId: source.rows[0].id };
}

interface SeedOptions {
  state?: 'visible' | 'hidden' | 'deleted';
  postedAt?: string;
  flagged?: boolean;
  authorId?: string | null;
  body?: string;
  isOwn?: boolean;
  parentId?: string;
  ingestedAt?: string;
}

async function seed(org: OrgFixture, s: typeof scopeA, o: SeedOptions = {}): Promise<string> {
  const { rows } = await api.pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                          platform_state, posted_at, author_id, is_own_account,
                          parent_comment_id, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))
     RETURNING id`,
    [
      org.orgId,
      s.brandId,
      s.connectionId,
      s.sourceId,
      `c-${randomUUID()}`,
      o.body ?? 'hello',
      o.state ?? 'visible',
      o.postedAt ?? new Date().toISOString(),
      o.authorId ?? null,
      o.isOwn ?? false,
      o.parentId ?? null,
      o.ingestedAt ?? null,
    ],
  );
  const id = rows[0].id as string;
  if (o.flagged) {
    await api.pool.query(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       VALUES ($1, $2, $3, $4, 'user')`,
      [org.orgId, s.brandId, s.connectionId, id],
    );
  }
  return id;
}

const get = (url: string, token = aToken): Promise<TestResponse> =>
  api.req('GET', url, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `203.0.113.${++ipCounter}` },
  });

const ids = (r: TestResponse): string[] => r.body.data.map((c: { id: string }) => c.id);

beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  A = await orgWithRoles(api, 'cmtA');
  B = await orgWithRoles(api, 'cmtB');
  scopeA = await scopeOf(A);
  scopeB = await scopeOf(B);
  const created = await new PgApiKeys(api.pool).create(A.orgId, A.owner.userId, {
    name: 'reader',
    scope: 'read',
  });
  aToken = created.token.reveal();
});
afterAll(() => api.close());

describe('GET /v1/comments', () => {
  let visible: string;
  let hidden: string;
  let flagged: string;
  let deleted: string;
  let bComment: string;
  beforeAll(async () => {
    visible = await seed(A, scopeA, { postedAt: '2026-01-01T10:00:00.000Z' });
    hidden = await seed(A, scopeA, { state: 'hidden', postedAt: '2026-01-02T10:00:00.000Z' });
    flagged = await seed(A, scopeA, { flagged: true, postedAt: '2026-01-03T10:00:00.000Z' });
    deleted = await seed(A, scopeA, { state: 'deleted', postedAt: '2026-01-04T10:00:00.000Z' });
    bComment = await seed(B, scopeB, { postedAt: '2026-01-05T10:00:00.000Z' });
  });

  it("returns only the key's organization, without deleted comments, matching the spec", async () => {
    const r = await get(
      '/v1/comments?postedFrom=2026-01-01T00:00:00Z&postedTo=2026-02-01T00:00:00Z',
    );
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([flagged, hidden, visible]);
    expect(ids(r)).not.toContain(deleted);
    expect(ids(r)).not.toContain(bComment);
    for (const item of r.body.data) CommentResource.parse(item);
    routeSpec('listComments').responses[200]!.parse(r.body);
    expect(r.body.nextCursor).toBeNull();
  });

  it.each([
    ['visible', () => [visible]],
    ['hidden', () => [hidden]],
    ['flagged', () => [flagged]],
  ])('filters status=%s', async (status, expected) => {
    const r = await get(`/v1/comments?status=${status}&postedFrom=2026-01-01T00:00:00Z`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(expected());
  });

  it('bounds postedFrom inclusively and postedTo exclusively', async () => {
    const edge = await get(
      '/v1/comments?postedFrom=2026-01-02T10:00:00.000Z&postedTo=2026-01-03T10:00:00.000Z',
    );
    expect(ids(edge)).toEqual([hidden]);
    const offset = await get(
      '/v1/comments?postedFrom=2026-01-02T12:00:00%2B02:00&postedTo=2026-01-03T12:00:00%2B02:00',
    );
    expect(ids(offset)).toEqual([hidden]);
  });

  it('rejects an empty or inverted range and a naive timestamp', async () => {
    for (const q of [
      'postedFrom=2026-01-03T10:00:00Z&postedTo=2026-01-03T10:00:00Z',
      'postedFrom=2026-01-04T10:00:00Z&postedTo=2026-01-03T10:00:00Z',
      'postedFrom=2026-01-03T10:00:00',
      'postedFrom=yesterday',
    ]) {
      const r = await get(`/v1/comments?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
  });

  it('filters by brand and rejects a malformed brandId', async () => {
    const own = await get(`/v1/comments?brandId=${scopeA.brandId}&postedFrom=2026-01-01T00:00:00Z`);
    expect(ids(own)).toHaveLength(3);
    const other = await get(`/v1/comments?brandId=${scopeB.brandId}`);
    expect(other.status).toBe(200);
    expect(ids(other)).toEqual([]);
    const bad = await get('/v1/comments?brandId=nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
  });

  it('rejects out-of-range limits, unknown parameters and statuses', async () => {
    for (const q of ['limit=101', 'limit=0', 'limit=abc', 'sort=asc', 'status=deleted']) {
      const r = await get(`/v1/comments?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    expect((await get('/v1/comments?limit=100')).status).toBe(200);
  });

  it('hides the author name of an erased author and carries the permalink fields', async () => {
    const author = await api.pool.query(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, $4, 'Ann') RETURNING id`,
      [A.orgId, scopeA.brandId, scopeA.connectionId, `a-${randomUUID()}`],
    );
    const id = await seed(A, scopeA, {
      authorId: author.rows[0].id,
      postedAt: '2026-03-01T00:00:00Z',
    });
    const named = await get(`/v1/comments/${id}`);
    expect(named.body).toMatchObject({ id, authorName: 'Ann', platform: 'facebook' });
    await api.pool.query(
      `UPDATE author SET display_name = NULL, anonymized_at = now(), external_id = 'erased:' || id
        WHERE id = $1`,
      [author.rows[0].id],
    );
    expect((await get(`/v1/comments/${id}`)).body.authorName).toBeNull();
  });

  it('answers 401 without a key', async () => {
    const r = await api.req('GET', '/v1/comments');
    expect(r.status).toBe(401);
  });
});

describe('cursors', () => {
  it('pages 3, 3, 1 and stays stable across inserts and deletes', async () => {
    const s = await scopeOf(A);
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      made.push(
        await seed(A, s, { postedAt: `2027-01-0${i + 1}T00:00:00.000Z`, body: `page ${i}` }),
      );
    }
    const q = `brandId=${s.brandId}&limit=3&postedFrom=2027-01-01T00:00:00Z&postedTo=2027-03-01T00:00:00Z`;
    const p1 = await get(`/v1/comments?${q}`);
    expect(ids(p1)).toEqual([made[6], made[5], made[4]]);
    expect(p1.body.nextCursor).toEqual(expect.any(String));

    const newer = await seed(A, s, { postedAt: '2027-02-01T00:00:00.000Z' });
    await api.pool.query('DELETE FROM comment WHERE id = $1', [made[5]]);

    const p2 = await get(`/v1/comments?${q}&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([made[3], made[2], made[1]]);
    const p3 = await get(`/v1/comments?${q}&cursor=${p2.body.nextCursor}`);
    expect(ids(p3)).toEqual([made[0]]);
    expect(p3.body.nextCursor).toBeNull();

    const union = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(new Set(union).size).toBe(union.length);
    // The deleted comment was already served on page 1; nothing else is skipped or repeated.
    expect([...union].sort()).toEqual([...made].sort());
    expect([...ids(p2), ...ids(p3)]).not.toContain(made[5]);
    expect(union).not.toContain(newer);
  });

  it('rejects a cursor reused with other filters, and tampered ones', async () => {
    const s = await scopeOf(A);
    for (let i = 0; i < 3; i++) await seed(A, s, { state: 'hidden' });
    const page = await get(`/v1/comments?status=hidden&brandId=${s.brandId}&limit=1`);
    const cursor = page.body.nextCursor as string;
    expect(cursor).toBeTruthy();
    const reused = await get(
      `/v1/comments?status=visible&brandId=${s.brandId}&limit=1&cursor=${cursor}`,
    );
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('invalid_cursor');
    const otherBrand = await get(`/v1/comments?status=hidden&limit=1&cursor=${cursor}`);
    expect(otherBrand.body.error.code).toBe('invalid_cursor');

    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(cursor, 'base64url').toString()),
        f: '0123456789abcdef',
      }),
    ).toString('base64url');
    for (const bad of [forged, 'not-a-cursor', cursor.slice(0, -6), '']) {
      const r = await get(`/v1/comments?status=hidden&brandId=${s.brandId}&limit=1&cursor=${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code, bad).toBe('invalid_cursor');
    }
  });
});

describe('search and reply-state filters', () => {
  let s: typeof scopeA;
  const base = '2028-01-01T00:00:00.000Z';
  const range = `postedFrom=${base}&postedTo=2028-02-01T00:00:00Z`;
  const at = (day: number) => `2028-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const insertAuthor = async (org: OrgFixture, sc: typeof scopeA, name: string) =>
    (
      await api.pool.query(
        `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [org.orgId, sc.brandId, sc.connectionId, `a-${randomUUID()}`, name],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    s = await scopeOf(A);
  });

  it('q matches body case-insensitively and author name; returns [] (200) when nothing matches', async () => {
    const byBody = await seed(A, s, { body: 'Great Product here', postedAt: at(1) });
    const author = await insertAuthor(A, s, 'Zebediah Quux');
    const byAuthor = await seed(A, s, { authorId: author, postedAt: at(2) });
    const r1 = await get(`/v1/comments?brandId=${s.brandId}&q=great%20PRODUCT&${range}`);
    expect(ids(r1)).toEqual([byBody]);
    const r2 = await get(`/v1/comments?brandId=${s.brandId}&q=zebediah&${range}`);
    expect(ids(r2)).toEqual([byAuthor]);
    const none = await get(`/v1/comments?brandId=${s.brandId}&q=nothing-matches-this&${range}`);
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
    expect((await get('/v1/comments?q=a')).status).toBe(400);
  });

  it('q does not match the name of an anonymized author', async () => {
    const author = await insertAuthor(A, s, 'Erasable Person');
    const id = await seed(A, s, { authorId: author, postedAt: at(3) });
    expect(ids(await get(`/v1/comments?brandId=${s.brandId}&q=erasable&${range}`))).toEqual([id]);
    await api.pool.query(
      `UPDATE author SET anonymized_at = now(), display_name = NULL, external_id = 'erased:' || id WHERE id = $1`,
      [author],
    );
    expect(ids(await get(`/v1/comments?brandId=${s.brandId}&q=erasable&${range}`))).toEqual([]);
  });

  it('q treats % and _ literally', async () => {
    const pct = await seed(A, s, { body: '50% off', postedAt: at(4) });
    await seed(A, s, { body: '500 off', postedAt: at(5) });
    const under = await seed(A, s, { body: 'snake_case', postedAt: at(6) });
    await seed(A, s, { body: 'snakeXcase', postedAt: at(7) });
    expect(ids(await get(`/v1/comments?brandId=${s.brandId}&q=50%25&${range}`))).toEqual([pct]);
    expect(ids(await get(`/v1/comments?brandId=${s.brandId}&q=ke_ca&${range}`))).toEqual([under]);
  });

  it('status=replied returns comments with an applied public_reply; status=unanswered excludes own-account and hidden comments', async () => {
    const t = await scopeOf(A);
    const q = `brandId=${t.brandId}&${range}`;
    const viaAction = await seed(A, t, { postedAt: at(10) });
    await api.pool.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, status, reply_text, completed_at)
       VALUES ($1, $2, $3, $4, 'public_reply', 'user', $5, $6, 'applied', 'thanks', now())`,
      [A.orgId, t.brandId, t.connectionId, viaAction, A.owner.userId, `seed:${randomUUID()}`],
    );
    const failedReply = await seed(A, t, { postedAt: at(11) });
    await api.pool.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind,
                                      actor_type, actor_user_id, request_key, status, reply_text, completed_at)
       VALUES ($1, $2, $3, $4, 'public_reply', 'user', $5, $6, 'failed', 'thanks', now())`,
      [A.orgId, t.brandId, t.connectionId, failedReply, A.owner.userId, `seed:${randomUUID()}`],
    );
    const viaChild = await seed(A, t, { postedAt: at(12) });
    await seed(A, t, { postedAt: at(13), isOwn: true, parentId: viaChild });
    const open = await seed(A, t, { postedAt: at(14) });
    const own = await seed(A, t, { postedAt: at(15), isOwn: true });
    const hidden = await seed(A, t, { postedAt: at(16), state: 'hidden' });

    const replied = await get(`/v1/comments?status=replied&${q}`);
    expect(ids(replied).sort()).toEqual([viaAction, viaChild].sort());
    const unanswered = ids(await get(`/v1/comments?status=unanswered&${q}`));
    expect(unanswered).toContain(open);
    expect(unanswered).toContain(failedReply);
    for (const excluded of [viaAction, viaChild, own, hidden]) {
      expect(unanswered).not.toContain(excluded);
    }
  });

  it('platform=instagram filters by connection platform', async () => {
    const ig = await scopeOf(A, 'instagram');
    const igComment = await seed(A, ig, { postedAt: at(20) });
    await seed(A, s, { postedAt: at(21) });
    const r = await get(`/v1/comments?platform=instagram&${range}`);
    expect(ids(r)).toEqual([igComment]);
    expect(r.body.data[0].platform).toBe('instagram');
    expect((await get('/v1/comments?platform=tiktok')).status).toBe(400);
  });

  it('snapshot cursor: a comment ingested after page 1 never shifts later pages', async () => {
    const t = await scopeOf(A);
    // The brand is shared with other tests, so read only the days this test seeds.
    const q = `brandId=${t.brandId}&limit=2&postedFrom=${at(22)}&postedTo=${at(26)}`;
    const orig = [];
    for (let d = 25; d >= 22; d--) orig.push(await seed(A, t, { postedAt: at(d) }));
    const p1 = await get(`/v1/comments?${q}`);
    expect(ids(p1)).toEqual([orig[0], orig[1]]);
    // Posted between items 2 and 3, but ingested after the snapshot was taken.
    const late = await seed(A, t, { postedAt: '2028-01-23T12:00:00.000Z' });
    const p2 = await get(`/v1/comments?${q}&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([orig[2], orig[3]]);
    expect(ids(p2)).not.toContain(late);
    expect(p2.body.nextCursor).toBeNull();
    // A fresh first page sees it.
    expect(ids(await get(`/v1/comments?${q.replace('limit=2', 'limit=5')}`))).toContain(late);
  });

  it('snapshot cursor: the first page applies no snapshot filter, later pages use the database clock', async () => {
    const t = await scopeOf(A);
    const q = `brandId=${t.brandId}&limit=1&postedFrom=${at(28)}&postedTo=${at(30)}`;
    // Ingested "in the future" relative to any API clock: page 1 must still return it.
    const future = await seed(A, t, {
      postedAt: at(29),
      ingestedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const older = await seed(A, t, { postedAt: at(28) });
    const p1 = await get(`/v1/comments?${q}`);
    expect(ids(p1)).toEqual([future]);
    // The cursor's snapshot is the database's time, which precedes that future ingested_at.
    const p2 = await get(`/v1/comments?${q}&cursor=${p1.body.nextCursor}`);
    expect(ids(p2)).toEqual([older]);
  });

  it('q from org A never returns org B comments', async () => {
    await seed(B, scopeB, { body: 'crosstenantneedle', postedAt: at(26) });
    const a = await seed(A, s, { body: 'crosstenantneedle', postedAt: at(27) });
    expect(ids(await get(`/v1/comments?q=crosstenantneedle&${range}`))).toEqual([a]);
  });
});

describe('GET /v1/comments/{id}', () => {
  it('returns the comment, matching its resource schema', async () => {
    const id = await seed(A, scopeA, { flagged: true });
    const r = await get(`/v1/comments/${id}`);
    expect(r.status).toBe(200);
    expect(routeSpec('getComment').responses[200]!.parse(r.body)).toMatchObject({
      id,
      status: 'flagged',
      flagged: true,
    });
  });

  it('answers 404 for another organization, a deleted comment, an archived brand and a bad id', async () => {
    const bId = await seed(B, scopeB);
    const deleted = await seed(A, scopeA, { state: 'deleted' });
    const archivedBrand = await api.pool.query(
      `INSERT INTO brand (organization_id, name, archived_at) VALUES ($1, 'old', now()) RETURNING id`,
      [A.orgId],
    );
    const archivedScope = await scopeOf({ ...A, brandId: archivedBrand.rows[0].id });
    const archived = await seed(A, archivedScope);
    for (const id of [bId, deleted, archived, randomUUID(), 'not-a-uuid']) {
      const r = await get(`/v1/comments/${id}`);
      expect(r.status, id).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    const list = await get(`/v1/comments?brandId=${archivedBrand.rows[0].id}`);
    expect(ids(list)).toEqual([]);
  });
});
