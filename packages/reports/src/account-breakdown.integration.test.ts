import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { computeAccountBreakdown } from './account-breakdown.js';
import { seedHide, seedProcessed } from './testing.js';

const FROM = new Date('2026-10-12T00:00:00Z');
const TO = new Date('2026-10-19T00:00:00Z');
const MID = new Date('2026-10-14T12:00:00Z');

let h: Awaited<ReturnType<typeof migratedDb>>;
let n = 0;
beforeAll(async () => {
  h = await migratedDb();
});
afterAll(async () => {
  await h.close();
});

const fresh = () => seedTenant(h.c, `ab${++n}`, { timezone: 'UTC' });
const run = (t: Tenant) =>
  computeAccountBreakdown(h.c, t.organizationId, { from: FROM, to: TO, brandId: t.brandId });
const one = async (sql: string, values: unknown[]) =>
  (await h.c.query<{ id: string }>(sql, values)).rows[0]!.id;

/** A further connection of the tenant's brand, with its own source; returned as a tenant view. */
async function secondConnection(t: Tenant): Promise<Tenant> {
  const connectionId = await one(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
     VALUES ($1, $2, 'instagram', $3, 'active') RETURNING id`,
    [t.organizationId, t.brandId, `ig-${randomUUID()}`],
  );
  const sourceId = await one(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4) RETURNING id`,
    [t.organizationId, t.brandId, connectionId, `post-${randomUUID()}`],
  );
  return { ...t, connectionId, sourceId };
}

const suggest = (t: Tenant, commentId: string, status: 'pending' | 'dismissed') =>
  h.c.query(
    `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256, status,
       decided_at)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), $5, CASE WHEN $5 = 'pending' THEN NULL ELSE now() END)`,
    [t.organizationId, t.brandId, t.connectionId, commentId, status],
  );

describe('computeAccountBreakdown', () => {
  it('two connections: counts split per connection', async () => {
    const a = await fresh();
    const b = await secondConnection(a);
    const hidden = await seedProcessed(h.c, a, { postedAt: MID });
    await seedHide(h.c, a, hidden, { by: 'classifier', category: 'spam' });
    await seedProcessed(h.c, a, { postedAt: MID, via: 'rule' });
    await seedProcessed(h.c, b, { postedAt: MID, via: 'none' });
    const rows = await run(a);
    expect(rows).toEqual([
      {
        connectionId: a.connectionId,
        comments: 2,
        imported: 0,
        checked: 2,
        hidden: 1,
        awaitingReview: 0,
        topCategories: [{ category: 'spam', count: 1 }],
      },
      {
        connectionId: b.connectionId,
        comments: 1,
        imported: 0,
        checked: 0,
        hidden: 0,
        awaitingReview: 0,
        topCategories: [],
      },
    ]);
  });

  it('imported counts only backfill-origin rows', async () => {
    const t = await fresh();
    const c1 = await seedProcessed(h.c, t, { postedAt: MID });
    await seedProcessed(h.c, t, { postedAt: MID });
    await h.c.query(`UPDATE comment SET ingest_origin = 'backfill' WHERE id = $1`, [c1]);
    const [row] = await run(t);
    expect(row).toMatchObject({ comments: 2, imported: 1 });
  });

  it('awaitingReview counts only pending suggestions', async () => {
    const t = await fresh();
    const c1 = await seedProcessed(h.c, t, { postedAt: MID });
    const c2 = await seedProcessed(h.c, t, { postedAt: MID });
    await suggest(t, c1, 'pending');
    await suggest(t, c2, 'dismissed');
    const [row] = await run(t);
    expect(row!.awaitingReview).toBe(1);
  });

  it('connection with no comments returns zeros', async () => {
    const t = await fresh();
    expect(await run(t)).toEqual([
      {
        connectionId: t.connectionId,
        comments: 0,
        imported: 0,
        checked: 0,
        hidden: 0,
        awaitingReview: 0,
        topCategories: [],
      },
    ]);
  });

  it("other org's comments are never counted", async () => {
    const a = await fresh();
    const other = await fresh();
    await seedProcessed(h.c, a, { postedAt: MID });
    const oh = await seedProcessed(h.c, other, { postedAt: MID });
    await seedHide(h.c, other, oh, { by: 'classifier', category: 'spam' });
    await suggest(other, await seedProcessed(h.c, other, { postedAt: MID }), 'pending');
    const rows = await run(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ comments: 1, hidden: 0, awaitingReview: 0, topCategories: [] });
    // Asking with the other org's brand under this org's id yields nothing.
    expect(
      await computeAccountBreakdown(h.c, a.organizationId, {
        from: FROM,
        to: TO,
        brandId: other.brandId,
      }),
    ).toEqual([]);
  });

  it('own-account and deleted comments excluded', async () => {
    const t = await fresh();
    await seedProcessed(h.c, t, { postedAt: MID, via: 'rule' });
    await seedProcessed(h.c, t, { postedAt: MID, own: true, via: 'rule' });
    const del = await seedProcessed(h.c, t, { postedAt: MID, via: 'rule' });
    await h.c.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [del]);
    await seedProcessed(h.c, t, { postedAt: TO });
    const [row] = await run(t);
    expect(row).toMatchObject({ comments: 1, checked: 1 });
  });

  it('omits connections the connection list hides', async () => {
    const t = await fresh();
    const gone = await secondConnection(t);
    await h.c.query(
      `UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected' WHERE id = $1`,
      [gone.connectionId],
    );
    expect((await run(t)).map((r) => r.connectionId)).toEqual([t.connectionId]);
  });
});
