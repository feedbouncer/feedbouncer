import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { BULK_MAX, PgTriage, TAGS_PER_COMMENT, TAGS_PER_ORG } from './triage.js';
import { seedCommentRow } from './testing.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let triage: PgTriage;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'actions-triage-test', onIdleError: () => {} });
  triage = new PgTriage(pool);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

const q = <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, p: unknown[] = []) =>
  ctx.c.query<T>(sql, p);
const fresh = () => seedTenant(ctx.c, `tr${++n}`);
const userOf = async (t: Tenant) =>
  (
    await q<{ user_id: string }>('SELECT user_id FROM membership WHERE organization_id = $1', [
      t.organizationId,
    ])
  ).rows[0]!.user_id;
const comment = (t: Tenant, body = `body ${++n}`, o: { state?: string } = {}) =>
  seedCommentRow(ctx.c, t, body, o);
const mkTag = async (t: Tenant, name: string) => {
  const r = await triage.createTag(t.organizationId, await userOf(t), name);
  if (r.status !== 'created') throw new Error(r.status);
  return r.tag;
};
const audits = async (orgId: string, action: string) =>
  (await q('SELECT * FROM audit_event WHERE organization_id = $1 AND action = $2', [orgId, action]))
    .rows;
const tagsOn = async (commentId: string) =>
  (
    await q<{ tag_id: string }>('SELECT tag_id FROM comment_tag WHERE comment_id = $1', [commentId])
  ).rows.map((r) => r.tag_id);
const isDone = async (commentId: string) =>
  (await q('SELECT 1 FROM comment_done WHERE comment_id = $1', [commentId])).rowCount === 1;

describe('tags', () => {
  it('createTag returns taken with the existing tag for a case variant; limit at 200', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const a = await triage.createTag(t.organizationId, u, 'Café');
    expect(a.status).toBe('created');
    const b = await triage.createTag(t.organizationId, u, 'CAFÉ');
    expect(b.status).toBe('taken');
    if (a.status === 'created' && b.status === 'taken') expect(b.tag.id).toBe(a.tag.id);
    expect(await triage.createTag(t.organizationId, u, '  ')).toEqual({
      status: 'invalid',
      error: 'empty',
    });
    expect((await audits(t.organizationId, 'tag.created')).length).toBe(1);

    await q(
      `INSERT INTO tag (organization_id, name, name_key)
       SELECT $1, 'bulk' || g, 'bulk' || g FROM generate_series(1, $2) g`,
      [t.organizationId, TAGS_PER_ORG - 1],
    );
    expect(await triage.createTag(t.organizationId, u, 'one too many')).toEqual({
      status: 'limit',
    });
  });

  it('listTags counts comments and never shows org B tags', async () => {
    const a = await fresh();
    const b = await fresh();
    const tag = await mkTag(a, 'Zeta');
    await mkTag(a, 'alpha');
    await mkTag(b, 'secret');
    const c1 = await comment(a);
    const c2 = await comment(a);
    await triage.apply(a.organizationId, await userOf(a), [c1.id, c2.id], {
      type: 'add_tags',
      tagIds: [tag.id],
    });
    const list = await triage.listTags(a.organizationId);
    expect(list.map((x) => [x.name, x.commentCount])).toEqual([
      ['alpha', 0],
      ['Zeta', 2],
    ]);
  });

  it('deleteTag with stale confirmCount -> count_changed; correct count -> deleted', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const tag = await mkTag(t, 'gone');
    const c1 = await comment(t);
    await triage.apply(t.organizationId, u, [c1.id], { type: 'add_tags', tagIds: [tag.id] });
    expect(await triage.deleteTag(t.organizationId, u, tag.id, 0)).toEqual({
      status: 'count_changed',
      count: 1,
    });
    expect(await tagsOn(c1.id)).toEqual([tag.id]);
    expect(await triage.deleteTag(t.organizationId, u, tag.id, 1)).toEqual({
      status: 'deleted',
      removedFrom: 1,
    });
    expect(await tagsOn(c1.id)).toEqual([]);
    const [ev] = await audits(t.organizationId, 'tag.deleted');
    expect(ev.details).toEqual({ name: 'gone', removedFrom: 1 });
  });

  it('deleteTag of org B tag -> not_found', async () => {
    const a = await fresh();
    const b = await fresh();
    const tag = await mkTag(b, 'b-only');
    expect(await triage.deleteTag(a.organizationId, await userOf(a), tag.id, 0)).toEqual({
      status: 'not_found',
    });
    expect(await triage.deleteTag(a.organizationId, await userOf(a), 'not-a-uuid', 0)).toEqual({
      status: 'not_found',
    });
    expect((await triage.listTags(b.organizationId)).length).toBe(1);
  });
});

describe('apply', () => {
  it('done then done -> changed false second time, one audit row; reopen removes; hidden ok', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t, 'x', { state: 'hidden' });
    const r1 = await triage.apply(t.organizationId, u, [c.id], { type: 'done' });
    const r2 = await triage.apply(t.organizationId, u, [c.id], { type: 'done' });
    expect(r1).toEqual({
      status: 'ok',
      results: [{ commentId: c.id, status: 'ok', changed: true }],
    });
    expect(r2).toEqual({
      status: 'ok',
      results: [{ commentId: c.id, status: 'ok', changed: false }],
    });
    expect(await isDone(c.id)).toBe(true);
    expect((await audits(t.organizationId, 'comment.marked_done')).length).toBe(1);
    const r3 = await triage.apply(t.organizationId, u, [c.id], { type: 'reopen' });
    expect(r3).toMatchObject({ results: [{ status: 'ok', changed: true }] });
    expect(await isDone(c.id)).toBe(false);
    const r4 = await triage.apply(t.organizationId, u, [c.id], { type: 'reopen' });
    expect(r4).toMatchObject({ results: [{ status: 'ok', changed: false }] });
    expect((await audits(t.organizationId, 'comment.reopened')).length).toBe(1);
  });

  it('two concurrent done calls on one comment both resolve ok', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t);
    const [a, b] = await Promise.all([
      new PgTriage(pool).apply(t.organizationId, u, [c.id], { type: 'done' }),
      new PgTriage(pool).apply(t.organizationId, u, [c.id], { type: 'done' }),
    ]);
    for (const r of [a, b]) expect(r).toMatchObject({ status: 'ok', results: [{ status: 'ok' }] });
    expect(await isDone(c.id)).toBe(true);
    expect((await audits(t.organizationId, 'comment.marked_done')).length).toBe(1);
  });

  it('two concurrent add_tags with different tags on one comment -> both present', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t);
    const t1 = await mkTag(t, 'one');
    const t2 = await mkTag(t, 'two');
    await Promise.all([
      new PgTriage(pool).apply(t.organizationId, u, [c.id], { type: 'add_tags', tagIds: [t1.id] }),
      new PgTriage(pool).apply(t.organizationId, u, [c.id], { type: 'add_tags', tagIds: [t2.id] }),
    ]);
    expect((await tagsOn(c.id)).sort()).toEqual([t1.id, t2.id].sort());
  });

  it('add_tags over 20 -> comment_tag_limit, nothing added for that comment', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t);
    const tags = [];
    for (let i = 0; i < TAGS_PER_COMMENT + 1; i++) tags.push(await mkTag(t, `t${i}`));
    const first = tags.slice(0, TAGS_PER_COMMENT - 1).map((x) => x.id);
    for (let i = 0; i < first.length; i += 10)
      await triage.apply(t.organizationId, u, [c.id], {
        type: 'add_tags',
        tagIds: first.slice(i, i + 10),
      });
    const over = await triage.apply(t.organizationId, u, [c.id], {
      type: 'add_tags',
      tagIds: tags.slice(TAGS_PER_COMMENT - 1).map((x) => x.id),
    });
    expect(over).toEqual({
      status: 'ok',
      results: [{ commentId: c.id, status: 'comment_tag_limit', changed: false }],
    });
    expect((await tagsOn(c.id)).length).toBe(TAGS_PER_COMMENT - 1);
    // Re-adding existing tags is not counted twice.
    const again = await triage.apply(t.organizationId, u, [c.id], {
      type: 'add_tags',
      tagIds: first.slice(0, 10),
    });
    expect(again).toMatchObject({ results: [{ status: 'ok', changed: false }] });
  });

  it('remove_tags removes and audits only real changes', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t);
    const t1 = await mkTag(t, 'r1');
    const t2 = await mkTag(t, 'r2');
    await triage.apply(t.organizationId, u, [c.id], { type: 'add_tags', tagIds: [t1.id] });
    const r = await triage.apply(t.organizationId, u, [c.id], {
      type: 'remove_tags',
      tagIds: [t1.id, t2.id],
    });
    expect(r).toMatchObject({ results: [{ status: 'ok', changed: true }] });
    expect(await tagsOn(c.id)).toEqual([]);
    expect((await audits(t.organizationId, 'comment.untagged')).length).toBe(1);
    expect((await audits(t.organizationId, 'comment.tagged')).length).toBe(1);
  });

  it('bulk: own, org B, unknown uuid, deleted -> ok, not_found, not_found, comment_deleted', async () => {
    const a = await fresh();
    const b = await fresh();
    const u = await userOf(a);
    const own = await comment(a);
    const theirs = await comment(b);
    const gone = await comment(a, 'g', { state: 'deleted' });
    const res = await triage.apply(a.organizationId, u, [own.id, theirs.id, uuid(), gone.id], {
      type: 'done',
    });
    expect(res).toMatchObject({ status: 'ok' });
    if (res.status !== 'ok') throw new Error();
    expect(res.results.map((r) => r.status)).toEqual([
      'ok',
      'not_found',
      'not_found',
      'comment_deleted',
    ]);
    expect(res.results.map((r) => r.commentId)).toEqual([
      own.id,
      theirs.id,
      res.results[2]!.commentId,
      gone.id,
    ]);
    expect(await isDone(own.id)).toBe(true);
    expect(await isDone(theirs.id)).toBe(false);
    expect(await isDone(gone.id)).toBe(false);
  });

  it('not_found for a comment on an archived brand and for a non-uuid id', async () => {
    const a = await fresh();
    const u = await userOf(a);
    const c = await comment(a);
    await q('UPDATE brand SET archived_at = now() WHERE id = $1', [a.brandId]);
    const res = await triage.apply(a.organizationId, u, [c.id, 'nope'], { type: 'done' });
    expect(res).toMatchObject({
      results: [{ status: 'not_found' }, { status: 'not_found' }],
    });
    expect(await triage.commentScope(a.organizationId, c.id)).toBeNull();
  });

  it('commentScope resolves own comments only', async () => {
    const a = await fresh();
    const b = await fresh();
    const c = await comment(a);
    expect(await triage.commentScope(a.organizationId, c.id)).toEqual({
      organizationId: a.organizationId,
      brandId: a.brandId,
    });
    expect(await triage.commentScope(b.organizationId, c.id)).toBeNull();
    expect(await triage.commentScope(a.organizationId, 'x')).toBeNull();
  });

  it('apply with an org B tag id -> unknown_tags and nothing changed', async () => {
    const a = await fresh();
    const b = await fresh();
    const c = await comment(a);
    const mine = await mkTag(a, 'mine');
    const theirs = await mkTag(b, 'theirs');
    const res = await triage.apply(a.organizationId, await userOf(a), [c.id], {
      type: 'add_tags',
      tagIds: [mine.id, theirs.id],
    });
    expect(res).toEqual({ status: 'unknown_tags' });
    expect(await tagsOn(c.id)).toEqual([]);
  });

  it('throws TypeError over the bulk and tag limits', async () => {
    const a = await fresh();
    const u = await userOf(a);
    const ids = Array.from({ length: BULK_MAX + 1 }, () => uuid());
    await expect(triage.apply(a.organizationId, u, ids, { type: 'done' })).rejects.toThrow(
      TypeError,
    );
    const tags = Array.from({ length: 11 }, () => uuid());
    await expect(
      triage.apply(a.organizationId, u, [uuid()], { type: 'add_tags', tagIds: tags }),
    ).rejects.toThrow(TypeError);
  });

  it('concurrent tag delete during bulk add -> unknown_tag per comment, others ok', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const tag = await mkTag(t, 'racy');
    const other = new PgTriage(pool);
    const racing = new PgTriage(pool, {
      beforeItem: async (i) => {
        if (i === 1) await other.deleteTag(t.organizationId, u, tag.id, 1);
      },
    });
    const cs = [await comment(t), await comment(t), await comment(t)];
    const res = await racing.apply(
      t.organizationId,
      u,
      cs.map((c) => c.id),
      {
        type: 'add_tags',
        tagIds: [tag.id],
      },
    );
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'unknown_tag', 'unknown_tag']);
  });

  it('audit details never contain comment body', async () => {
    const t = await fresh();
    const u = await userOf(t);
    const c = await comment(t, 'SENTINEL-BODY-xyzzy');
    const tag = await mkTag(t, 'plain');
    await triage.apply(t.organizationId, u, [c.id], { type: 'done' });
    await triage.apply(t.organizationId, u, [c.id], { type: 'add_tags', tagIds: [tag.id] });
    const rows = await q<{ d: string }>(
      'SELECT details::text AS d FROM audit_event WHERE organization_id = $1',
      [t.organizationId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.some((r) => r.d.includes('SENTINEL-BODY'))).toBe(false);
  });
});
