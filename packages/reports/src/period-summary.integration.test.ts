import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { MAX_SUMMARY_DAYS, computePeriodSummary, resolveSummaryRange } from './period-summary.js';
import { seedHide, seedProcessed } from './testing.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-19T08:00:00Z');
const FROM = new Date('2026-10-12T00:00:00Z');
const TO = new Date('2026-10-19T00:00:00Z');
const MID = new Date('2026-10-14T12:00:00Z');

describe('resolveSummaryRange', () => {
  it('defaults to the last 7 days ending now', () => {
    expect(resolveSummaryRange({}, NOW)).toEqual({
      from: new Date(NOW.getTime() - 7 * DAY),
      to: NOW,
      bounded: null,
    });
  });

  it('bounds a 100-day range to the maximum, keeping the end', () => {
    const from = new Date(TO.getTime() - 100 * DAY);
    expect(resolveSummaryRange({ from, to: TO }, NOW)).toEqual({
      from: new Date(TO.getTime() - MAX_SUMMARY_DAYS * DAY),
      to: TO,
      bounded: { requestedFrom: from.toISOString(), reason: 'max_range_92_days' },
    });
  });

  it('rejects an end before the start', () => {
    expect(() => resolveSummaryRange({ from: TO, to: FROM }, NOW)).toThrow(
      new RangeError('to_before_from'),
    );
  });

  it('rejects an end more than 5 minutes ahead, but allows clock skew', () => {
    const hour = new Date(NOW.getTime() + 3_600_000);
    expect(() => resolveSummaryRange({ to: hour }, NOW)).toThrow(new RangeError('to_in_future'));
    const skew = new Date(NOW.getTime() + 60_000);
    expect(resolveSummaryRange({ to: skew }, NOW).to).toEqual(skew);
  });
});

let h: Awaited<ReturnType<typeof migratedDb>>;
let n = 0;
beforeAll(async () => {
  h = await migratedDb();
});
afterAll(async () => {
  await h.close();
});

const fresh = () => seedTenant(h.c, `ps${++n}`, { timezone: 'UTC' });
const summary = (t: Tenant, brandId?: string) =>
  computePeriodSummary(h.c, t.organizationId, { from: FROM, to: TO, ...(brandId && { brandId }) });
const one = async (sql: string, values: unknown[]) =>
  (await h.c.query<{ id: string }>(sql, values)).rows[0]!.id;

/** A second brand in the tenant's organization, with its own connection and source. */
async function secondBrand(t: Tenant): Promise<Tenant> {
  const brandId = await one(
    'INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING id',
    [t.organizationId, `Second ${randomUUID()}`],
  );
  const connectionId = await one(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
     VALUES ($1, $2, 'facebook', $3, 'active') RETURNING id`,
    [t.organizationId, brandId, `page-${randomUUID()}`],
  );
  const sourceId = await one(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'ad_post', $4) RETURNING id`,
    [t.organizationId, brandId, connectionId, `post-${randomUUID()}`],
  );
  return { ...t, brandId, connectionId, sourceId };
}

/** A reply from the account itself under `parentId`. */
const ownReply = (t: Tenant, parentId: string) =>
  one(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, parent_comment_id, external_id,
       body, is_own_account, ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'thanks', true, 'live', $7) RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, parentId, `ext-${randomUUID()}`, MID],
  );

describe('computePeriodSummary', () => {
  it('is all zeros and empty lists for an empty range', async () => {
    expect(await summary(await fresh())).toEqual({
      totals: { comments: 0, hidden: 0, replied: 0, unanswered: 0 },
      categories: [],
      topRules: [],
      notableThreads: [],
    });
  });

  it('totals add up and exclude own-account and out-of-range comments', async () => {
    const t = await fresh();
    const hidden = await seedProcessed(h.c, t, { postedAt: MID });
    await seedHide(h.c, t, hidden, { by: 'classifier', category: 'spam' });
    const replied = await seedProcessed(h.c, t, { postedAt: MID });
    await ownReply(t, replied);
    await seedProcessed(h.c, t, { postedAt: MID });
    await seedProcessed(h.c, t, { postedAt: MID, own: true });
    await seedProcessed(h.c, t, { postedAt: TO });
    await seedProcessed(h.c, t, { postedAt: new Date(FROM.getTime() - 1) });
    const s = await summary(t);
    expect(s.totals).toEqual({ comments: 3, hidden: 1, replied: 1, unanswered: 1 });
    expect(s.categories).toEqual([{ category: 'spam', count: 1 }]);
  });

  it('ranks top rules by matches', async () => {
    const t = await fresh();
    const other = await one(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
       SELECT organization_id, brand_id, 'Second rule', conditions, action FROM rule WHERE id = $1
       RETURNING id`,
      [t.ruleId],
    );
    await seedProcessed(h.c, t, { postedAt: MID, via: 'rule' });
    for (let i = 0; i < 2; i++) {
      const c = await seedProcessed(h.c, t, { postedAt: MID, via: 'none' });
      await h.c.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
         VALUES ($1, $2, $3, 'approve', 'enforce', 'rule', $4, 'Seeded.')`,
        [t.organizationId, t.brandId, c, other],
      );
    }
    const { topRules } = await summary(t);
    expect(topRules).toEqual([
      { ruleId: other, name: 'Second rule', matches: 2 },
      { ruleId: t.ruleId, name: expect.any(String), matches: 1 },
    ]);
  });

  it('ranks notable threads by replies, newest first on ties, capped at 5', async () => {
    const t = await fresh();
    const quiet = await seedProcessed(h.c, t, { postedAt: MID });
    const busy = await seedProcessed(h.c, t, { postedAt: new Date(MID.getTime() - DAY) });
    await ownReply(t, busy);
    await ownReply(t, busy);
    const newer = await seedProcessed(h.c, t, { postedAt: new Date(MID.getTime() + DAY) });
    await h.c.query('UPDATE comment SET body = $2 WHERE id = $1', [newer, 'x'.repeat(400)]);
    for (let i = 0; i < 4; i++)
      await seedProcessed(h.c, t, { postedAt: new Date(FROM.getTime() + i) });
    const { notableThreads } = await summary(t);
    expect(notableThreads).toHaveLength(5);
    expect(notableThreads[0]).toMatchObject({ commentId: busy, replies: 2, platform: 'facebook' });
    expect(notableThreads[1]).toMatchObject({ commentId: newer, replies: 0 });
    expect(notableThreads[1]!.textPreview).toHaveLength(280);
    expect(notableThreads[2]!.commentId).toBe(quiet);
  });

  it('shows no author name for an anonymized author', async () => {
    const t = await fresh();
    const c = await seedProcessed(h.c, t, { postedAt: MID });
    await h.c.query('UPDATE comment SET author_id = $2 WHERE id = $1', [c, t.authorId]);
    await h.c.query(`UPDATE author SET display_name = 'Dana', anonymized_at = NULL WHERE id = $1`, [
      t.authorId,
    ]);
    expect((await summary(t)).notableThreads[0]!.authorName).toBe('Dana');
    await h.c.query('UPDATE author SET display_name = NULL, anonymized_at = now() WHERE id = $1', [
      t.authorId,
    ]);
    expect((await summary(t)).notableThreads[0]!.authorName).toBeNull();
  });

  it('filters by brand', async () => {
    const t = await fresh();
    const b2 = await secondBrand(t);
    await seedProcessed(h.c, t, { postedAt: MID });
    await seedProcessed(h.c, b2, { postedAt: MID });
    await seedProcessed(h.c, b2, { postedAt: MID });
    expect((await summary(t)).totals.comments).toBe(3);
    expect((await summary(t, t.brandId)).totals.comments).toBe(1);
    expect((await summary(t, b2.brandId)).totals.comments).toBe(2);
  });

  it("excludes another organization's data", async () => {
    const a = await fresh();
    const b = await fresh();
    const c = await seedProcessed(h.c, b, { postedAt: MID });
    await seedHide(h.c, b, c, { by: 'rule' });
    expect(await summary(a)).toMatchObject({ totals: { comments: 0 }, topRules: [] });
    expect(await summary(a, b.brandId)).toMatchObject({ totals: { comments: 0 }, topRules: [] });
  });
});
