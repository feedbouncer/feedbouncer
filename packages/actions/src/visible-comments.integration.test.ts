import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { ConnectionStatus, Platform } from '@feedbouncer/connectors';
import {
  NO_AD,
  PgVisibleComments,
  UNCATEGORIZED,
  accountProblem,
  visibleCountQuery,
  visibleListQuery,
  type VisibleCommentFilter,
} from './visible-comments.js';
import { NEGATIVE_COMMENT_SQL } from './negative.js';
import { seedModerationActionRow, seedSuggestionRow, type Seeded } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgVisibleComments;
let n = 0;
let adSeq = 1000;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'actions-visible-comments-test',
    onIdleError: () => {},
  });
  store = new PgVisibleComments(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const NONE: VisibleCommentFilter = {
  platform: null,
  adId: null,
  category: null,
  status: null,
  queue: 'all',
  tagIds: [],
  brandId: null,
  postedFrom: null,
  postedTo: null,
  signal: null,
};
const filter = (f: Partial<VisibleCommentFilter> = {}): VisibleCommentFilter => ({ ...NONE, ...f });
const FIRST = { before: null, limit: 100 };
const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, p: unknown[] = []) =>
  ctx.c.query<T>(sql, p);
const at = (hhmm: string) => `2026-10-16T${hhmm}:00Z`;

const fresh = () => seedTenant(ctx.c, `vc${++n}`);

async function addBrand(t: Tenant, name: string, archived = false): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO brand (organization_id, name, archived_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id`,
    [t.organizationId, name, archived],
  );
  return r.rows[0]!.id;
}

/** A connection with one source and one author; shaped like a Tenant so seed helpers accept it. */
async function addConn(
  t: Tenant,
  brandId: string,
  platform: Platform,
  o: { status?: ConnectionStatus; name?: string | null } = {},
): Promise<Tenant> {
  const ext = `acct-${++n}`;
  const conn = await q<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name, status, review_mode)
     VALUES ($1, $2, $3, $4, $5, $6, 'legacy') RETURNING id`,
    [t.organizationId, brandId, platform, ext, o.name ?? null, o.status ?? 'active'],
  );
  const connectionId = conn.rows[0]!.id;
  const src = async (kind: string) =>
    (
      await q<{ id: string }>(
        `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [t.organizationId, brandId, connectionId, kind, `post-${++n}`],
      )
    ).rows[0]!.id;
  const authorId = (
    await q<{ id: string }>(
      `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [t.organizationId, brandId, connectionId, `psid-${++n}`, `Author ${n}`],
    )
  ).rows[0]!.id;
  return {
    ...t,
    brandId,
    connectionId,
    sourceId: await src('organic_post'),
    otherSourceId: await src('organic_post'),
    authorId,
  };
}

async function post(
  t: Tenant,
  o: {
    at?: string;
    body?: string;
    state?: string;
    own?: boolean;
    parentId?: string;
    sourceId?: string;
    adSourceId?: string;
  } = {},
): Promise<Seeded> {
  const body = o.body ?? 'hello';
  const r = await q<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, ad_source_id, external_id, body,
       platform_state, is_own_account, parent_comment_id, author_id, ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'live', $12) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      o.sourceId ?? t.sourceId,
      o.adSourceId ?? null,
      `ext-${++n}`,
      body,
      o.state ?? 'visible',
      o.own ?? false,
      o.parentId ?? null,
      t.authorId,
      o.at ?? at('12:00'),
    ],
  );
  return { id: r.rows[0]!.id, body, t };
}

async function addAd(
  ads: Tenant,
  o: { name?: string | null; deleted?: boolean } = {},
): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
       effective_status, active, facebook_resolution, instagram_resolution, last_discovered_at, name, deleted_at)
     VALUES ($1, $2, $3, $4, '1', 'ACTIVE', true, 'linked', 'not_instagram', now(), $5,
       CASE WHEN $6 THEN now() END) RETURNING id`,
    [
      ads.organizationId,
      ads.brandId,
      ads.connectionId,
      String(++adSeq),
      o.name === undefined ? `Ad ${adSeq}` : o.name,
      o.deleted ?? false,
    ],
  );
  return r.rows[0]!.id;
}
const link = (
  ads: Tenant,
  adId: string,
  sourceId: string,
  platform: 'facebook' | 'instagram' = 'facebook',
  unlinked = false,
) =>
  // Linking an ad promotes its source to an ad post, as ad tracking does.
  q(
    `WITH promoted AS (UPDATE source SET kind = 'ad_post' WHERE id = $4)
     INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform, unlinked_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END)`,
    [ads.organizationId, ads.brandId, adId, sourceId, platform, unlinked],
  );

const decide = (s: Seeded, category: string | null, outcome = 'approve') =>
  q(
    `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason, category)
     VALUES ($1, $2, $3, $4, 'enforce', 'user', $5, 'because', $6)`,
    [s.t.organizationId, s.t.brandId, s.id, outcome, s.t.userId, category],
  );
const reviewItem = (s: Seeded, status: 'open' | 'resolved') =>
  q(
    `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, status, resolution, resolved_at)
     VALUES ($1, $2, $3, $4, 'rule', $5, CASE WHEN $5 = 'resolved' THEN 'dismissed' END,
       CASE WHEN $5 = 'resolved' THEN now() END)`,
    [s.t.organizationId, s.t.brandId, s.t.connectionId, s.id, status],
  );
const suggestion = async (s: Seeded, status: 'pending' | 'approved' | 'dismissed' = 'pending') => {
  const id = await seedSuggestionRow(ctx.c, s);
  if (status !== 'pending')
    await q(`UPDATE action_suggestion SET status = $2, decided_at = now() WHERE id = $1`, [
      id,
      status,
    ]);
};

const markDone = (s: Seeded, byUser: string | null = s.t.userId) =>
  q(
    `INSERT INTO comment_done (organization_id, brand_id, comment_id, done_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [s.t.organizationId, s.t.brandId, s.id, byUser],
  );
const addTag = async (orgId: string, name: string): Promise<string> =>
  (
    await q<{ id: string }>(
      `INSERT INTO tag (organization_id, name, name_key) VALUES ($1, $2, lower($2)) RETURNING id`,
      [orgId, name],
    )
  ).rows[0]!.id;
const tagComment = (s: Seeded, tagId: string) =>
  q(
    `INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id) VALUES ($1, $2, $3, $4)`,
    [s.t.organizationId, s.t.brandId, s.id, tagId],
  );

/** Org A with two brands, Facebook x2, Instagram and a meta_ads connection. */
async function world() {
  const fb1 = await fresh();
  const brand2 = await addBrand(fb1, 'Second brand');
  return {
    orgId: fb1.organizationId,
    fb1,
    fb2: await addConn(fb1, brand2, 'facebook', { name: 'Second page' }),
    ig: await addConn(fb1, fb1.brandId, 'instagram', { name: 'Insta' }),
    ads: await addConn(fb1, fb1.brandId, 'meta_ads'),
  };
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);
async function all(orgId: string, f: VisibleCommentFilter, limit = 2): Promise<string[]> {
  const out: string[] = [];
  let before = null;
  for (;;) {
    const p: Awaited<ReturnType<typeof store.list>> = await store.list(orgId, f, { before, limit });
    out.push(...ids(p.items));
    if (!p.next) return out;
    before = p.next;
  }
}

describe('PgVisibleComments', () => {
  it('lists visible comments from every brand and connection of the org, newest first', async () => {
    const w = await world();
    const a = await post(w.fb1, { at: at('09:00'), body: 'first' });
    const b = await post(w.fb2, { at: at('11:00') });
    const c = await post(w.ig, { at: at('10:00') });
    const reply = await post(w.fb1, { at: at('08:00'), parentId: a.id });
    const r = await store.list(w.orgId, NONE, FIRST);
    expect(ids(r.items)).toEqual([b.id, c.id, a.id, reply.id]);
    expect(r.total).toBe(4);
    expect(r.next).toBeNull();
    const top = r.items[0]!;
    expect(top).toMatchObject({
      brandId: w.fb2.brandId,
      brandName: 'Second brand',
      connectionId: w.fb2.connectionId,
      connectionName: 'Second page',
      platform: 'facebook',
      body: 'hello',
      permalink: null,
      isReply: false,
      ads: [],
      adCount: 0,
      category: null,
      status: 'new',
      stale: false,
    });
    expect(top.authorName).toMatch(/^Author /);
    expect(top.postedAt).toEqual(new Date(at('11:00')));
    expect(r.items[3]!.isReply).toBe(true);
    expect(r.items[2]).toMatchObject({ body: 'first', connectionName: null });
  });

  it('marks a reply whose parent was erased or purged as parentRemoved', async () => {
    const w = await world();
    const a = await post(w.fb1, { at: at('09:00') });
    const kept = await post(w.fb1, { at: at('08:00'), parentId: a.id });
    const orphan = await post(w.fb1, { at: at('07:00'), parentId: a.id });
    await q(
      `UPDATE comment SET parent_removed_at = now(), parent_comment_id = NULL WHERE id = $1`,
      [orphan.id],
    );
    const byId = new Map((await store.list(w.orgId, NONE, FIRST)).items.map((i) => [i.id, i]));
    expect(byId.get(orphan.id)).toMatchObject({ isReply: true, parentRemoved: true });
    expect(byId.get(kept.id)!.parentRemoved).toBe(false);
    expect(byId.get(a.id)!.parentRemoved).toBe(false);
  });

  it('excludes hidden, deleted, own-account comments, revoked connections and archived brands', async () => {
    const w = await world();
    const keep = await post(w.fb1);
    await post(w.fb1, { state: 'hidden' });
    await post(w.fb1, { state: 'deleted' });
    await post(w.fb1, { own: true });
    const revoked = await addConn(w.fb1, w.fb1.brandId, 'facebook', { status: 'revoked' });
    await post(revoked);
    const archived = await addBrand(w.fb1, 'Old', true);
    await post(await addConn(w.fb1, archived, 'facebook'));
    const paused = await addConn(w.fb1, w.fb1.brandId, 'facebook', { status: 'paused' });
    const pausedComment = await post(paused);
    const r = await store.list(w.orgId, NONE, FIRST);
    expect(new Set(ids(r.items))).toEqual(new Set([keep.id, pausedComment.id]));
    expect(r.total).toBe(2);
  });

  it('never returns org B rows, for list, count, options and accounts', async () => {
    const a = await fresh();
    const b = await fresh();
    const bIg = await addConn(b, b.brandId, 'instagram');
    const bAds = await addConn(b, b.brandId, 'meta_ads');
    const aComment = await post(a);
    const bComment = await post(bIg);
    await decide(bComment, 'b_only_cat');
    const bAd = await addAd(bAds, { name: 'B ad' });
    await link(bAds, bAd, bIg.sourceId, 'instagram');
    const r = await store.list(a.organizationId, NONE, FIRST);
    expect(ids(r.items)).toEqual([aComment.id]);
    expect(r.total).toBe(1);
    const o = await store.options(a.organizationId);
    expect(o).toMatchObject({ platforms: ['facebook'], ads: [], categories: [] });
    const acc = await store.accounts(a.organizationId);
    expect(acc.map((x) => x.connectionId)).toEqual([a.connectionId]);
    const byB = await store.list(a.organizationId, filter({ adId: bAd }), FIRST);
    expect(byB.items).toEqual([]);
    expect(byB.total).toBe(0);
    const applied = await store.applicable(a.organizationId, filter({ adId: bAd }));
    expect(applied.adId).toBeNull();
  });

  describe('filters', () => {
    let w: Awaited<ReturnType<typeof world>>;
    const c = {} as Record<'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6', string>;
    let ad1: string;
    let ad2: string;

    beforeAll(async () => {
      w = await world();
      ad1 = await addAd(w.ads, { name: 'Spring sale' });
      ad2 = await addAd(w.ads, { name: 'Summer sale' });
      await link(w.ads, ad1, w.fb1.sourceId);
      await link(w.ads, ad2, w.ig.sourceId, 'instagram');
      const c1 = await post(w.fb1, { at: at('10:00') });
      const c2 = await post(w.fb1, { at: at('09:00') });
      const c3 = await post(w.ig, { at: at('08:00') });
      const c4 = await post(w.fb2, { at: at('07:00') });
      const c5 = await post(w.fb2, { at: at('06:00') });
      const c6 = await post(w.fb1, { at: at('05:00'), sourceId: w.fb1.otherSourceId });
      Object.assign(c, {
        c1: c1.id,
        c2: c2.id,
        c3: c3.id,
        c4: c4.id,
        c5: c5.id,
        c6: c6.id,
      });
      await decide(c1, 'spam');
      await reviewItem(c1, 'open');
      await decide(c2, 'scam');
      await decide(c3, 'spam');
      await suggestion(c3);
      await reviewItem(c5, 'resolved');
      await decide(c6, 'spam');
      await decide(c6, null);
      await decide(c6, 'scam');
    });

    const run = async (f: Partial<VisibleCommentFilter>) => {
      const r = await store.list(w.orgId, filter(f), FIRST);
      expect(r.total).toBe(r.items.length);
      return ids(r.items);
    };

    it('platform filter', async () => {
      expect(await run({ platform: 'instagram' })).toEqual([c.c3]);
      expect(await run({ platform: 'facebook' })).toEqual([c.c1, c.c2, c.c4, c.c5, c.c6]);
    });
    it('ad filter by id', async () => {
      expect(await run({ adId: ad1 })).toEqual([c.c1, c.c2]);
      expect(await run({ adId: ad2 })).toEqual([c.c3]);
    });
    it('ad=none returns organic only', async () => {
      expect(await run({ adId: NO_AD })).toEqual([c.c4, c.c5, c.c6]);
    });
    it('category filter uses the newest non-null category; _none returns uncategorized', async () => {
      expect(await run({ category: 'spam' })).toEqual([c.c1, c.c3]);
      expect(await run({ category: 'scam' })).toEqual([c.c2, c.c6]);
      expect(await run({ category: UNCATEGORIZED })).toEqual([c.c4, c.c5]);
      const r = await store.list(w.orgId, NONE, FIRST);
      expect(r.items.map((i) => i.category)).toEqual(['spam', 'scam', 'spam', null, null, 'scam']);
    });
    it('status filter', async () => {
      expect(await run({ status: 'flagged' })).toEqual([c.c1]);
      expect(await run({ status: 'awaiting_action' })).toEqual([c.c3]);
      expect(await run({ status: 'reviewed' })).toEqual([c.c2, c.c5, c.c6]);
      expect(await run({ status: 'new' })).toEqual([c.c4]);
    });
    it('combined filters are ANDed', async () => {
      expect(await run({ platform: 'facebook', category: 'spam' })).toEqual([c.c1]);
      expect(await run({ platform: 'facebook', category: 'spam', status: 'flagged' })).toEqual([
        c.c1,
      ]);
      expect(await run({ platform: 'facebook', adId: NO_AD, status: 'reviewed' })).toEqual([
        c.c5,
        c.c6,
      ]);
      expect(await run({ platform: 'instagram', adId: ad2, category: 'spam' })).toEqual([c.c3]);
      expect(await run({ platform: 'facebook', category: 'scam', status: 'reviewed' })).toEqual([
        c.c2,
        c.c6,
      ]);
      expect(
        await run({ platform: 'facebook', category: 'scam', status: 'reviewed', adId: ad1 }),
      ).toEqual([c.c2]);
      expect(await run({ platform: 'instagram', category: 'scam' })).toEqual([]);
      expect(await run({ adId: ad1, status: 'new' })).toEqual([]);
    });
    it('total equals the number of rows across all pages for every filter above', async () => {
      const filters = [
        NONE,
        filter({ platform: 'facebook' }),
        filter({ adId: ad1 }),
        filter({ adId: NO_AD }),
        filter({ category: 'spam' }),
        filter({ category: UNCATEGORIZED }),
        filter({ status: 'reviewed' }),
        filter({ platform: 'facebook', category: 'scam', status: 'reviewed' }),
      ];
      for (const f of filters) {
        const total = (await store.list(w.orgId, f, FIRST)).total;
        expect(await all(w.orgId, f, 2)).toHaveLength(total);
        expect((await store.list(w.orgId, f, { before: null, limit: 2 })).total).toBe(total);
      }
    });
    it('options list platforms, ads with platforms and brand, categories and statuses', async () => {
      const o = await store.options(w.orgId);
      expect(o.platforms).toEqual(['facebook', 'instagram']);
      expect(o.categories).toEqual(['scam', 'spam']);
      expect(o.statuses).toEqual(['new', 'flagged', 'awaiting_action', 'reviewed']);
      expect(o.adsTruncated).toBe(false);
      expect(o.ads).toEqual([
        {
          adId: ad1,
          externalId: expect.stringMatching(/^\d+$/),
          name: 'Spring sale',
          deleted: false,
          adAccountExternalId: '1',
          brandName: expect.any(String),
          platforms: ['facebook'],
        },
        expect.objectContaining({ adId: ad2, name: 'Summer sale', platforms: ['instagram'] }),
      ]);
    });
  });

  it('status precedence: open review item, pending work, then reviewed, otherwise new', async () => {
    const w = await world();
    const t = w.fb1;
    const flaggedWithSuggestion = await post(t, { at: at('12:00') });
    await reviewItem(flaggedWithSuggestion, 'open');
    await suggestion(flaggedWithSuggestion);
    const pendingSuggestion = await post(t, { at: at('11:00') });
    await suggestion(pendingSuggestion);
    const pendingHide = await post(t, { at: at('10:00') });
    await seedModerationActionRow(ctx.c, pendingHide, { kind: 'hide', status: 'pending' });
    const resolved = await post(t, { at: at('09:00') });
    await reviewItem(resolved, 'resolved');
    const approved = await post(t, { at: at('08:00') });
    await suggestion(approved, 'approved');
    const dismissed = await post(t, { at: at('07:00') });
    await suggestion(dismissed, 'dismissed');
    const userDecision = await post(t, { at: at('06:00') });
    await decide(userDecision, null);
    const userReply = await post(t, { at: at('05:00') });
    await seedModerationActionRow(ctx.c, userReply, { kind: 'public_reply', actorType: 'user' });
    const nothing = await post(t, { at: at('04:00') });
    const expired = await post(t, { at: at('03:00') });
    await suggestion(expired);
    await q(
      `UPDATE action_suggestion SET status = 'expired', decided_at = now() WHERE comment_id = $1`,
      [expired.id],
    );
    const r = await store.list(w.orgId, NONE, FIRST);
    expect(r.items.map((i) => [i.id, i.status])).toEqual([
      [flaggedWithSuggestion.id, 'flagged'],
      [pendingSuggestion.id, 'awaiting_action'],
      [pendingHide.id, 'awaiting_action'],
      [resolved.id, 'reviewed'],
      [approved.id, 'reviewed'],
      [dismissed.id, 'reviewed'],
      [userDecision.id, 'reviewed'],
      [userReply.id, 'reviewed'],
      [nothing.id, 'new'],
      [expired.id, 'new'],
    ]);
  });

  it('keyset paging over 120 comments sharing 3 posted_at values returns every id exactly once', async () => {
    const w = await world();
    await q(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, ingest_origin, posted_at)
       SELECT $1, $2, $3, $4, 'bulk-' || g, 'b', 'live',
              ('2026-10-16T10:00:00Z'::timestamptz - (g % 3) * interval '1 minute')
         FROM generate_series(1, 120) g`,
      [w.orgId, w.fb1.brandId, w.fb1.connectionId, w.fb1.sourceId],
    );
    const seen: string[] = [];
    const sizes: number[] = [];
    let before = null;
    for (;;) {
      const p: Awaited<ReturnType<typeof store.list>> = await store.list(w.orgId, NONE, {
        before,
        limit: 50,
      });
      sizes.push(p.items.length);
      seen.push(...ids(p.items));
      expect(p.total).toBe(120);
      if (!p.next) break;
      before = p.next;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
  });

  it('a comment linked to three ads through two sources is listed once with adCount 3 and counted once', async () => {
    const w = await world();
    const [x, y, z] = [
      await addAd(w.ads, { name: 'beta' }),
      await addAd(w.ads, { name: 'Alpha' }),
      await addAd(w.ads, { name: null }),
    ] as [string, string, string];
    const t = w.fb1;
    await link(w.ads, x, t.sourceId);
    await link(w.ads, y, t.sourceId);
    await link(w.ads, z, t.otherSourceId);
    await link(w.ads, x, t.otherSourceId);
    const s = await post(t, { sourceId: t.sourceId, adSourceId: t.otherSourceId });
    const r = await store.list(w.orgId, NONE, FIRST);
    expect(ids(r.items)).toEqual([s.id]);
    expect(r.total).toBe(1);
    expect(r.items[0]!.adCount).toBe(3);
    expect(r.items[0]!.ads.map((a) => a.adId)).toEqual([y, x, z]);
    for (const adId of [x, y, z]) {
      const f = await store.list(w.orgId, filter({ adId }), FIRST);
      expect([f.total, f.items.length]).toEqual([1, 1]);
    }
    expect((await store.list(w.orgId, filter({ adId: NO_AD }), FIRST)).total).toBe(0);
  });

  it('caps listed ads at 5 but counts them all', async () => {
    const w = await world();
    for (let i = 0; i < 7; i++) await link(w.ads, await addAd(w.ads), w.fb1.sourceId);
    await post(w.fb1);
    const r = await store.list(w.orgId, NONE, FIRST);
    expect([r.items[0]!.ads.length, r.items[0]!.adCount]).toEqual([5, 7]);
  });

  it('comment with a pending hide is listed as awaiting_action; after the hide applies it is gone from list, count and ad options', async () => {
    const w = await world();
    const adId = await addAd(w.ads);
    await link(w.ads, adId, w.fb1.sourceId);
    const s = await post(w.fb1);
    const action = await seedModerationActionRow(ctx.c, s, { kind: 'hide', status: 'pending' });
    let r = await store.list(w.orgId, NONE, FIRST);
    expect(r.items.map((i) => [i.id, i.status])).toEqual([[s.id, 'awaiting_action']]);
    expect((await store.options(w.orgId)).ads.map((a) => a.adId)).toEqual([adId]);

    await q(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [s.id]);
    await q(`UPDATE moderation_action SET status = 'applied', completed_at = now() WHERE id = $1`, [
      action,
    ]);
    r = await store.list(w.orgId, NONE, FIRST);
    expect([r.items.length, r.total]).toEqual([0, 0]);
    expect((await store.options(w.orgId)).ads).toEqual([]);
  });

  it('comment keeps its ad after the link is unlinked and the ad is deleted', async () => {
    const w = await world();
    const adId = await addAd(w.ads, { name: 'Gone', deleted: true });
    await link(w.ads, adId, w.fb1.sourceId, 'facebook', true);
    const s = await post(w.fb1);
    const r = await store.list(w.orgId, filter({ adId }), FIRST);
    expect(ids(r.items)).toEqual([s.id]);
    expect(r.total).toBe(1);
    expect(r.items[0]!.ads[0]).toMatchObject({ adId, name: 'Gone', deleted: true });
    expect((await store.options(w.orgId)).ads[0]).toMatchObject({ adId, deleted: true });
  });

  it('revoking a connection removes its comments, its platform option (when it was the last) and its ads from options', async () => {
    const w = await world();
    const adId = await addAd(w.ads);
    await link(w.ads, adId, w.ig.sourceId, 'instagram');
    const fb = await post(w.fb1, { at: at('10:00') });
    await post(w.ig, { at: at('11:00') });
    expect((await store.options(w.orgId)).platforms).toEqual(['facebook', 'instagram']);
    expect((await store.options(w.orgId)).ads).toHaveLength(1);

    await q(`UPDATE connection SET status = 'revoked' WHERE id = $1`, [w.ig.connectionId]);
    const r = await store.list(w.orgId, NONE, FIRST);
    expect(ids(r.items)).toEqual([fb.id]);
    expect(r.total).toBe(1);
    const o = await store.options(w.orgId);
    expect(o.platforms).toEqual(['facebook']);
    expect(o.ads).toEqual([]);
    expect((await store.accounts(w.orgId)).map((a) => a.connectionId)).not.toContain(
      w.ig.connectionId,
    );
  });

  describe('deep-link filters', () => {
    const negate = (s: Seeded, o: { outcome?: string; mode?: string } = {}) =>
      q(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason)
         VALUES ($1, $2, $3, $4, $5, 'user', $6, 'because')`,
        [
          s.t.organizationId,
          s.t.brandId,
          s.id,
          o.outcome ?? 'hide',
          o.mode ?? 'enforce',
          s.t.userId,
        ],
      );

    it('signal negative returns exactly the visible comments counted by NEGATIVE_COMMENT_SQL for the same brand and range', async () => {
      const w = await world();
      const from = new Date(at('10:00'));
      const to = new Date(at('11:00'));
      const inRange = [
        await post(w.fb1, { at: at('10:00') }),
        await post(w.fb1, { at: at('10:30') }),
        await post(w.fb1, { at: at('10:59') }),
      ];
      for (const s of inRange)
        await negate(s, { outcome: inRange.indexOf(s) === 2 ? 'flag' : 'hide' });
      const plain = await post(w.fb1, { at: at('10:15') });
      await decide(plain, null, 'approve');
      const suggested = await post(w.fb1, { at: at('10:16') });
      await negate(suggested, { mode: 'suggest' });
      const early = await post(w.fb1, { at: at('09:59') });
      await negate(early);
      const atTo = await post(w.fb1, { at: at('11:00') });
      await negate(atTo);
      const own = await post(w.fb1, { at: at('10:20'), own: true });
      await negate(own);
      const hidden = await post(w.fb1, { at: at('10:21'), state: 'hidden' });
      await negate(hidden);
      const otherBrand = await post(w.fb2, { at: at('10:30') });
      await negate(otherBrand);

      const expected = await q<{ id: string }>(
        `SELECT c.id FROM comment c
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.posted_at >= $3 AND c.posted_at < $4
            AND c.platform_state = 'visible' AND (${NEGATIVE_COMMENT_SQL})`,
        [w.orgId, w.fb1.brandId, from, to],
      );
      expect(expected.rows).toHaveLength(3);
      const f = filter({
        brandId: w.fb1.brandId,
        postedFrom: from,
        postedTo: to,
        signal: 'negative',
      });
      const r = await store.list(w.orgId, f, FIRST);
      expect(ids(r.items).sort()).toEqual(expected.rows.map((x) => x.id).sort());
      expect(ids(r.items).sort()).toEqual(inRange.map((x) => x.id).sort());
      expect(r.total).toBe(3);
      // Without the signal the other in-range comments show up.
      expect((await store.list(w.orgId, { ...f, signal: null }, FIRST)).total).toBeGreaterThan(3);
    });

    it('brand filter excludes other brands; org B brand id ignored', async () => {
      const w = await world();
      const b = await world();
      const a1 = await post(w.fb1);
      await post(w.fb2);
      await post(b.fb1);
      const r = await store.list(w.orgId, filter({ brandId: w.fb1.brandId }), FIRST);
      expect(ids(r.items)).toEqual([a1.id]);
      expect(r.total).toBe(1);
      const ap = await store.applicable(w.orgId, filter({ brandId: b.fb1.brandId }));
      expect(ap.brandId).toBeNull();
      const archived = await addBrand(w.fb1, 'Gone', true);
      expect((await store.applicable(w.orgId, filter({ brandId: archived }))).brandId).toBeNull();
      expect((await store.applicable(w.orgId, filter({ brandId: w.fb1.brandId }))).brandId).toBe(
        w.fb1.brandId,
      );
    });

    it('from/to bound posted_at', async () => {
      const w = await world();
      const c8 = await post(w.fb1, { at: at('08:00') });
      const c9 = await post(w.fb1, { at: at('09:00') });
      const c10 = await post(w.fb1, { at: at('10:00') });
      const range = async (f: Partial<VisibleCommentFilter>) =>
        ids((await store.list(w.orgId, filter(f), FIRST)).items);
      const d = (hhmm: string) => new Date(at(hhmm));
      expect(await range({ postedFrom: d('09:00') })).toEqual([c10.id, c9.id]);
      expect(await range({ postedTo: d('09:00') })).toEqual([c8.id]);
      expect(await range({ postedFrom: d('08:30'), postedTo: d('10:00') })).toEqual([c9.id]);
      const ap = await store.applicable(
        w.orgId,
        filter({ postedFrom: d('08:30'), signal: 'negative' }),
      );
      expect(ap).toMatchObject({ postedFrom: d('08:30'), postedTo: null, signal: 'negative' });
    });
  });

  describe('account health', () => {
    const sync = (
      t: Tenant,
      o: { ok?: string | null; fail?: string | null; cls?: string | null; n?: number },
    ) =>
      q(
        `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at, last_failure_at,
           last_error_code, last_error_class, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          t.connectionId,
          t.organizationId,
          t.brandId,
          o.ok ?? null,
          o.fail ?? null,
          o.fail ? 'oops' : null,
          o.fail ? (o.cls ?? 'retryable') : null,
          o.n ?? 0,
        ],
      );

    it('stale is true only for rows of a connection whose problem is set; accounts() reports problem and lastSyncedAt', async () => {
      const w = await world();
      await q(`UPDATE connection SET status = 'reconnect_required' WHERE id = $1`, [
        w.ig.connectionId,
      ]);
      await sync(w.fb2, { ok: at('09:00'), fail: at('10:00'), n: 3 });
      await sync(w.fb1, { ok: at('08:00') });
      const healthy = await post(w.fb1, { at: at('12:00') });
      const reconnect = await post(w.ig, { at: at('11:00') });
      const failing = await post(w.fb2, { at: at('10:00') });
      const r = await store.list(w.orgId, NONE, FIRST);
      expect(r.items.map((i) => [i.id, i.stale])).toEqual([
        [healthy.id, false],
        [reconnect.id, true],
        [failing.id, true],
      ]);
      const acc = await store.accounts(w.orgId);
      expect(acc).toHaveLength(3);
      const by = (t: Tenant) => acc.find((a) => a.connectionId === t.connectionId)!;
      expect(by(w.fb1)).toMatchObject({
        problem: null,
        platform: 'facebook',
        lastSyncedAt: new Date(at('08:00')),
      });
      expect(by(w.ig)).toMatchObject({
        problem: 'reconnect_required',
        displayName: 'Insta',
        lastSyncedAt: null,
      });
      expect(by(w.fb2)).toMatchObject({
        problem: 'sync_failing',
        brandName: 'Second brand',
        displayName: 'Second page',
      });
    });

    it('agrees with accountProblem for every combination', async () => {
      const w = await world();
      const cases: {
        status: ConnectionStatus;
        cls: string | null;
        n: number;
        fail: string | null;
        ok: string | null;
      }[] = [
        { status: 'active', cls: null, n: 0, fail: null, ok: null },
        { status: 'reconnect_required', cls: null, n: 0, fail: null, ok: null },
        { status: 'error', cls: null, n: 0, fail: null, ok: null },
        { status: 'paused', cls: null, n: 0, fail: null, ok: null },
        { status: 'active', cls: 'needs_reconnection', n: 1, fail: at('10:00'), ok: at('11:00') },
        { status: 'active', cls: 'retryable', n: 3, fail: at('11:00'), ok: at('10:00') },
        { status: 'active', cls: 'retryable', n: 3, fail: at('11:00'), ok: null },
        { status: 'active', cls: 'retryable', n: 2, fail: at('11:00'), ok: at('10:00') },
        { status: 'active', cls: 'retryable', n: 9, fail: at('10:00'), ok: at('11:00') },
        { status: 'paused', cls: 'retryable', n: 4, fail: at('11:00'), ok: at('10:00') },
      ];
      const expected = new Map<string, unknown>();
      for (const k of cases) {
        const t = await addConn(w.fb1, w.fb1.brandId, 'facebook', { status: k.status });
        if (k.fail || k.ok || k.n) await sync(t, { ok: k.ok, fail: k.fail, cls: k.cls, n: k.n });
        const row = await post(t);
        expected.set(
          row.id,
          accountProblem({
            status: k.status,
            lastErrorClass: k.fail ? k.cls : null,
            consecutiveFailures: k.n,
            lastFailureAt: k.fail ? new Date(k.fail) : null,
            lastSuccessAt: k.ok ? new Date(k.ok) : null,
          }),
        );
        expected.set(t.connectionId, expected.get(row.id));
      }
      const acc = await store.accounts(w.orgId);
      const list = await store.list(w.orgId, NONE, FIRST);
      for (const a of acc.filter((x) => expected.has(x.connectionId)))
        expect(a.problem).toBe(expected.get(a.connectionId));
      for (const i of list.items.filter((x) => expected.has(x.id)))
        expect(i.stale).toBe(expected.get(i.id) !== null);
    });
  });

  it('applicable drops an org B ad id, an unknown category and an unconnected platform, and keeps none/_none', async () => {
    const a = await world();
    const b = await world();
    const adA = await addAd(a.ads);
    await link(a.ads, adA, a.fb1.sourceId);
    const sa = await post(a.fb1);
    await decide(sa, 'spam');
    const adB = await addAd(b.ads);
    await link(b.ads, adB, b.fb1.sourceId);
    await post(b.fb1);
    const ap = (f: Partial<VisibleCommentFilter>) => store.applicable(a.orgId, filter(f));
    expect(await ap({ adId: adB, category: 'unknown', platform: 'tiktok' })).toEqual(NONE);
    expect(await ap({ adId: NO_AD, category: UNCATEGORIZED })).toMatchObject({
      adId: NO_AD,
      category: UNCATEGORIZED,
    });
    expect(await ap({ adId: adA, category: 'spam', platform: 'facebook', status: 'new' })).toEqual({
      adId: adA,
      category: 'spam',
      platform: 'facebook',
      status: 'new',
      queue: 'all',
      tagIds: [],
      brandId: null,
      postedFrom: null,
      postedTo: null,
      signal: null,
    });
    expect((await ap({ adId: '00000000-0000-4000-8000-000000000000' })).adId).toBeNull();
  });

  describe('triage read model', () => {
    it('queue open excludes done comments from list and count; done shows only them; all shows both', async () => {
      const w = await world();
      const open = await post(w.fb1, { at: at('10:00') });
      const done = await post(w.fb1, { at: at('09:00') });
      await markDone(done);
      const run = async (queue: 'open' | 'done' | 'all') => {
        const r = await store.list(w.orgId, filter({ queue }), FIRST);
        expect(r.total).toBe(r.items.length);
        return ids(r.items);
      };
      expect(await run('open')).toEqual([open.id]);
      expect(await run('done')).toEqual([done.id]);
      expect(await run('all')).toEqual([open.id, done.id]);
    });

    it('done is independent of hidden: unhiding a done comment keeps it done', async () => {
      const w = await world();
      const s = await post(w.fb1);
      await markDone(s);
      await q(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [s.id]);
      expect((await store.list(w.orgId, filter({ queue: 'done' }), FIRST)).total).toBe(0);
      await q(`UPDATE comment SET platform_state = 'visible' WHERE id = $1`, [s.id]);
      const r = await store.list(w.orgId, filter({ queue: 'done' }), FIRST);
      expect(ids(r.items)).toEqual([s.id]);
      expect(r.items[0]!.done).not.toBeNull();
    });

    it('tags filter requires all selected tags; combines with platform and status', async () => {
      const w = await world();
      const [t1, t2] = [await addTag(w.orgId, 'Refund'), await addTag(w.orgId, 'VIP')];
      const both = await post(w.fb1, { at: at('10:00') });
      const onlyOne = await post(w.fb1, { at: at('09:00') });
      const ig = await post(w.ig, { at: at('08:00') });
      await tagComment(both, t1);
      await tagComment(both, t2);
      await tagComment(onlyOne, t1);
      await tagComment(ig, t1);
      await tagComment(ig, t2);
      await reviewItem(both, 'open');
      const run = async (f: Partial<VisibleCommentFilter>) => {
        const r = await store.list(w.orgId, filter(f), FIRST);
        expect(r.total).toBe(r.items.length);
        return ids(r.items);
      };
      expect(await run({ tagIds: [t1] })).toEqual([both.id, onlyOne.id, ig.id]);
      expect(await run({ tagIds: [t1, t2] })).toEqual([both.id, ig.id]);
      expect(await run({ tagIds: [t1, t2], platform: 'instagram' })).toEqual([ig.id]);
      expect(await run({ tagIds: [t1, t2], status: 'flagged' })).toEqual([both.id]);
    });

    it('applicable drops an org B tag id and an unknown uuid, de-duplicates and keeps queue', async () => {
      const a = await world();
      const b = await world();
      const tA = await addTag(a.orgId, 'Mine');
      const tB = await addTag(b.orgId, 'Theirs');
      const r = await store.applicable(
        a.orgId,
        filter({
          queue: 'done',
          tagIds: [tA, tB, '00000000-0000-4000-8000-000000000000', tA],
        }),
      );
      expect(r.tagIds).toEqual([tA]);
      expect(r.queue).toBe('done');
    });

    it('row has done {at, byName}, tags sorted case-insensitively, the latest 3 replies and replyCount', async () => {
      const w = await world();
      await q(`UPDATE app_user SET display_name = 'Dana' WHERE id = $1`, [w.fb1.userId]);
      const s = await post(w.fb1);
      await markDone(s);
      for (const name of ['beta', 'Alpha', 'Charlie'])
        await tagComment(s, await addTag(w.orgId, name));
      const mk = async (
        text: string,
        createdAt: string,
        o: { actor?: string; status?: string } = {},
      ) => {
        const id = await seedModerationActionRow(ctx.c, s, {
          kind: 'public_reply',
          actorType: o.actor ?? 'user',
          status: o.status ?? 'applied',
          replyText: text,
          createdAt,
        });
        if ((o.actor ?? 'user') === 'user')
          await q(`UPDATE moderation_action SET actor_user_id = $2 WHERE id = $1`, [
            id,
            w.fb1.userId,
          ]);
      };
      await mk('r1', at('01:00'));
      await mk('r2', at('02:00'), { actor: 'rule' });
      await mk('r3', at('03:00'), { status: 'pending' });
      await mk('r4', at('04:00'));
      await seedModerationActionRow(ctx.c, s, { kind: 'hide', createdAt: at('05:00') });
      const row = (await store.list(w.orgId, NONE, FIRST)).items[0]!;
      expect(row.done).toEqual({ at: expect.any(Date), byName: 'Dana' });
      expect(row.tags.map((t) => t.name)).toEqual(['Alpha', 'beta', 'Charlie']);
      expect(row.replyCount).toBe(4);
      expect(row.replies.map((r) => [r.text, r.status, r.authorName])).toEqual([
        ['r4', 'applied', 'Dana'],
        ['r3', 'pending', 'Dana'],
        ['r2', 'applied', null],
      ]);
      expect(row.replies[0]).toMatchObject({ actorType: 'user', createdAt: expect.any(Date) });
      expect(row.replies[1]!.completedAt).toBeNull();
      expect(row.replies[0]!.completedAt).toBeInstanceOf(Date);
      const plain = await post(w.fb1, { at: at('11:00') });
      const p = (await store.list(w.orgId, NONE, FIRST)).items.find((i) => i.id === plain.id)!;
      expect(p).toMatchObject({ done: null, tags: [], replies: [], replyCount: 0 });
    });

    it('a failed reply is not in replies', async () => {
      const w = await world();
      const s = await post(w.fb1);
      await seedModerationActionRow(ctx.c, s, { kind: 'public_reply', status: 'failed' });
      const row = (await store.list(w.orgId, NONE, FIRST)).items[0]!;
      expect([row.replies, row.replyCount]).toEqual([[], 0]);
    });

    it('replyTarget for a reply-to-reply uses the parent platform state', async () => {
      const w = await world();
      const top = await post(w.fb1, { at: at('09:00') });
      const child = await post(w.fb1, { at: at('10:00'), parentId: top.id });
      await q(`UPDATE comment SET parent_external_id = $2 WHERE id = $1`, [child.id, 'ext-parent']);
      await q(`UPDATE comment SET platform_state = 'hidden' WHERE id = $1`, [top.id]);
      const r = await store.list(w.orgId, NONE, FIRST);
      expect(r.items.map((i) => i.id)).toEqual([child.id]);
      expect(r.items[0]!.replyTarget).toEqual({
        connectionStatus: 'active',
        hasAuthor: true,
        parentExternalId: 'ext-parent',
        targetPlatformState: 'hidden',
      });
      const plain = await post(w.fb1, { at: at('11:00') });
      const p = (await store.list(w.orgId, NONE, FIRST)).items.find((i) => i.id === plain.id)!;
      expect(p.replyTarget).toEqual({
        connectionStatus: 'active',
        hasAuthor: true,
        parentExternalId: null,
        targetPlatformState: 'visible',
      });
    });

    it('org B tags never in options or rows', async () => {
      const a = await world();
      const b = await world();
      const tA = await addTag(a.orgId, 'zeta');
      const tAa = await addTag(a.orgId, 'Alpha');
      const tB = await addTag(b.orgId, 'b-only');
      const sa = await post(a.fb1);
      await tagComment(sa, tA);
      expect((await store.options(a.orgId)).tags).toEqual([
        { id: tAa, name: 'Alpha' },
        { id: tA, name: 'zeta' },
      ]);
      const row = (await store.list(a.orgId, NONE, FIRST)).items[0]!;
      expect(row.tags).toEqual([{ id: tA, name: 'zeta' }]);
      expect(JSON.stringify(await store.options(a.orgId))).not.toContain(tB);
    });
  });

  it('adsTruncated when 501 ads have comments', async () => {
    const w = await world();
    const t = w.fb1;
    await q(
      `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
         effective_status, active, facebook_resolution, instagram_resolution, last_discovered_at)
       SELECT $1, $2, $3, (5000 + g)::text, '1', 'ACTIVE', true, 'linked', 'not_instagram', now()
         FROM generate_series(1, 501) g`,
      [t.organizationId, t.brandId, w.ads.connectionId],
    );
    await q(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       SELECT $1, $2, $3, 'ad_post', 'bulk-' || g FROM generate_series(1, 501) g`,
      [t.organizationId, t.brandId, t.connectionId],
    );
    await q(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       SELECT $1, $2, a.id, s.id, 'facebook'
         FROM meta_ad a JOIN source s ON s.external_id = 'bulk-' || (a.external_id::int - 5000)
        WHERE a.ads_connection_id = $4 AND s.connection_id = $3`,
      [t.organizationId, t.brandId, t.connectionId, w.ads.connectionId],
    );
    await q(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, ingest_origin, posted_at)
       SELECT $1, $2, $3, s.id, 'c-' || s.external_id, 'b', 'live', now()
         FROM source s WHERE s.connection_id = $3 AND s.external_id LIKE 'bulk-%'`,
      [t.organizationId, t.brandId, t.connectionId],
    );
    const o = await store.options(w.orgId);
    expect(o.ads).toHaveLength(500);
    expect(o.adsTruncated).toBe(true);
  });

  it('performance: 30,000 comments across 3 connections', async () => {
    const w = await world();
    const conns = [w.fb1, w.fb2, w.ig];
    await q(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, ingest_origin, posted_at)
       SELECT $1, (ARRAY[$2, $3, $4]::uuid[])[1 + g % 3], (ARRAY[$5, $6, $7]::uuid[])[1 + g % 3],
              (ARRAY[$8, $9, $10]::uuid[])[1 + g % 3], 'p-' || g, 'body ' || g, 'live',
              '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second'
         FROM generate_series(1, 30000) g`,
      [
        w.orgId,
        ...conns.map((c) => c.brandId),
        ...conns.map((c) => c.connectionId),
        ...conns.map((c) => c.sourceId),
      ],
    );
    await q(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason, category)
       SELECT organization_id, brand_id, id, 'approve', 'enforce', 'user', $2, 'r',
              CASE WHEN body::text LIKE '%1' THEN 'spam' ELSE 'scam' END
         FROM comment WHERE organization_id = $1 AND external_id LIKE 'p-%' AND external_id LIKE '%0'`,
      [w.orgId, w.fb1.userId],
    );
    await q(
      `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
       SELECT organization_id, brand_id, connection_id, id, 'rule' FROM comment
        WHERE organization_id = $1 AND external_id LIKE 'p-%7'`,
      [w.orgId],
    );
    await q(
      `INSERT INTO comment_done (organization_id, brand_id, comment_id, done_by_user_id)
       SELECT organization_id, brand_id, id, $2 FROM comment
        WHERE organization_id = $1 AND external_id LIKE 'p-%' AND external_id LIKE '%3'`,
      [w.orgId, w.fb1.userId],
    );
    await q('ANALYZE comment');
    await q('ANALYZE comment_done');
    await q('ANALYZE decision');
    await q('ANALYZE review_item');

    const explain = async (text: string, values: unknown[], noSeqScan = false) => {
      const c = await pool.connect();
      try {
        if (noSeqScan) await c.query('SET enable_seqscan = off');
        const r = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values);
        const plan = r.rows[0]['QUERY PLAN'][0];
        const json = JSON.stringify(plan);
        return {
          ms: plan['Execution Time'] as number,
          json,
          indexes: [...json.matchAll(/"Index Name":"([^"]+)"/g)].map((m) => m[1]),
        };
      } finally {
        await c.query('RESET enable_seqscan').catch(() => {});
        c.release();
      }
    };
    const page = { before: null, limit: 50 };
    const open = filter({ queue: 'open' });
    const first = visibleListQuery(w.orgId, open, page);
    const indexed = await explain(first.text, first.values, true);
    expect(indexed.indexes).toContain('comment_visible_organization_id_posted_at_idx');

    for (const f of [open, filter({ queue: 'open', category: 'spam', status: 'flagged' })]) {
      const l = visibleListQuery(w.orgId, f, page);
      const k = visibleCountQuery(w.orgId, f);
      expect((await explain(l.text, l.values)).ms).toBeLessThan(1500);
      expect((await explain(k.text, k.values)).ms).toBeLessThan(1500);
    }
    expect((await store.list(w.orgId, open, page)).total).toBe(27000);
    expect((await store.list(w.orgId, NONE, page)).total).toBe(30000);
  });
});
