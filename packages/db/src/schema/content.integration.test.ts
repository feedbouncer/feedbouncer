import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'a');
  b = await seedTenant(ctx.c, 'b');
});
afterAll(() => ctx.close());

type CommentOpts = Partial<{
  org: string;
  brand: string;
  connection: string;
  sourceId: string;
  externalId: string;
  authorId: string | null;
  parentCommentId: string | null;
  parentExternalId: string | null;
  body: string;
  postedAt: string;
}>;

const INSERT = `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                  parent_comment_id, parent_external_id, body, posted_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
function values(t: Tenant, o: CommentOpts = {}) {
  return [
    o.org ?? t.organizationId,
    o.brand ?? t.brandId,
    o.connection ?? t.connectionId,
    o.sourceId ?? t.sourceId,
    o.externalId ?? `c-${uuid()}`,
    o.authorId === undefined ? t.authorId : o.authorId,
    o.parentCommentId ?? null,
    o.parentExternalId ?? null,
    o.body ?? 'hello',
    o.postedAt ?? '2026-10-01T12:00:00Z',
  ];
}
async function insertComment(c: pg.ClientBase, t: Tenant, o: CommentOpts = {}): Promise<string> {
  return (await c.query<{ id: string }>(`${INSERT} RETURNING id`, values(t, o))).rows[0]!.id;
}

describe('duplicate ingestion', () => {
  it('rejects a second plain insert of the same external id in the same source', async () => {
    await insertComment(ctx.c, a, { externalId: 'dup-1' });
    await expectPgError(
      insertComment(ctx.c, a, { externalId: 'dup-1' }),
      '23505',
      'comment_source_id_external_id_key',
    );
  });

  it('ON CONFLICT DO NOTHING ignores the duplicate deterministically and keeps the original', async () => {
    const first = await insertComment(ctx.c, a, { externalId: 'dup-2', body: 'original' });
    const r = await ctx.c.query(
      `${INSERT} ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id`,
      values(a, { externalId: 'dup-2', body: 'replayed' }),
    );
    expect(r.rowCount).toBe(0);
    const rows = (
      await ctx.c.query('SELECT id, body FROM comment WHERE source_id = $1 AND external_id = $2', [
        a.sourceId,
        'dup-2',
      ])
    ).rows;
    expect(rows).toEqual([{ id: first, body: 'original' }]);
  });

  it('ten concurrent deliveries of one comment produce exactly one row', async () => {
    const clients = await Promise.all(Array.from({ length: 10 }, () => ctx.db.client()));
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query(
            `${INSERT} ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id`,
            values(a, { externalId: 'race-1' }),
          ),
        ),
      );
      expect(results.reduce((n, r) => n + (r.rowCount ?? 0), 0)).toBe(1);
      expect(
        (await ctx.c.query("SELECT count(*)::int AS n FROM comment WHERE external_id = 'race-1'"))
          .rows[0].n,
      ).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('the same external id is allowed in another source and in another organization', async () => {
    await insertComment(ctx.c, a, { externalId: 'shared-1' });
    await insertComment(ctx.c, a, { externalId: 'shared-1', sourceId: a.otherSourceId });
    await insertComment(ctx.c, b, { externalId: 'shared-1' });
  });

  it('sources and authors are unique per connection by external id', async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id) VALUES ($1,$2,$3,'ad_post','post-a-1')",
        [a.organizationId, a.brandId, a.connectionId],
      ),
      '23505',
      'source_connection_id_external_id_key',
    );
    await expectPgError(
      ctx.c.query(
        'INSERT INTO author (organization_id, brand_id, connection_id, external_id) VALUES ($1,$2,$3,$4)',
        [a.organizationId, a.brandId, a.connectionId, 'psid-a'],
      ),
      '23505',
      'author_connection_id_external_id_key',
    );
  });
});

describe('cross-tenant isolation', () => {
  it("a comment cannot point at another organization's source", async () => {
    await expectPgError(
      insertComment(ctx.c, a, { sourceId: b.sourceId }),
      '23503',
      'comment_organization_id_brand_id_connection_id_source_id_fkey',
    );
  });
  it("a comment cannot claim another organization's scope even with a matching source", async () => {
    await expectPgError(
      insertComment(ctx.c, a, { org: b.organizationId }),
      '23503',
      'comment_organization_id_brand_id_connection_id_source_id_fkey',
    );
  });
  it('a comment cannot use an author from another connection', async () => {
    await expectPgError(
      insertComment(ctx.c, a, { authorId: b.authorId }),
      '23503',
      'comment_connection_id_author_id_fkey',
    );
  });
  it('a reply cannot have a parent from another source', async () => {
    const parent = await insertComment(ctx.c, a, { sourceId: a.otherSourceId });
    await expectPgError(
      insertComment(ctx.c, a, { parentCommentId: parent }),
      '23503',
      'comment_source_id_parent_comment_id_fkey',
    );
  });
  it("a source cannot point at another brand's connection", async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id) VALUES ($1,$2,$3,'video','v')",
        [a.organizationId, a.brandId, b.connectionId],
      ),
      '23503',
      'source_organization_id_brand_id_connection_id_fkey',
    );
  });
});

describe('threads', () => {
  it('stores a reply whose parent has not arrived yet, then links it', async () => {
    const reply = await insertComment(ctx.c, a, { parentExternalId: 'late-parent' });
    const parent = await insertComment(ctx.c, a, { externalId: 'late-parent' });
    const linked = await ctx.c.query(
      `UPDATE comment SET parent_comment_id = $1 WHERE source_id = $2 AND parent_external_id = $3 AND parent_comment_id IS NULL RETURNING id`,
      [parent, a.sourceId, 'late-parent'],
    );
    expect(linked.rows.map((r) => r.id)).toEqual([reply]);
  });

  it('deleting a parent keeps its replies intact', async () => {
    const parent = await insertComment(ctx.c, a, { externalId: 'p-del' });
    const reply = await insertComment(ctx.c, a, {
      parentCommentId: parent,
      parentExternalId: 'p-del',
      body: 'still here',
    });
    await ctx.c.query('DELETE FROM comment WHERE id = $1', [parent]);
    const r = (
      await ctx.c.query(
        'SELECT parent_comment_id, parent_external_id, source_id, body FROM comment WHERE id = $1',
        [reply],
      )
    ).rows[0];
    expect(r).toEqual({
      parent_comment_id: null,
      parent_external_id: 'p-del',
      source_id: a.sourceId,
      body: 'still here',
    });
  });

  it('a comment cannot be its own parent', async () => {
    const id = await insertComment(ctx.c, a);
    await expectPgError(
      ctx.c.query('UPDATE comment SET parent_comment_id = id WHERE id = $1', [id]),
      '23514',
      'comment_parent_not_self_check',
    );
  });
});

describe('author erasure', () => {
  it('anonymizing an author keeps comments coherent', async () => {
    const t = await seedTenant(ctx.c, `anon-${uuid()}`);
    const cid = await insertComment(ctx.c, t);
    await ctx.c.query(
      "UPDATE author SET display_name = NULL, external_id = 'erased:' || id, anonymized_at = now() WHERE id = $1",
      [t.authorId],
    );
    expect(
      (await ctx.c.query('SELECT author_id FROM comment WHERE id = $1', [cid])).rows[0].author_id,
    ).toBe(t.authorId);
  });
  it('an anonymized author cannot keep a display name', async () => {
    await expectPgError(
      ctx.c.query(
        "UPDATE author SET anonymized_at = now(), display_name = 'Still Named' WHERE id = $1",
        [a.authorId],
      ),
      '23514',
      'author_anonymized_check',
    );
  });
  it('deleting an author nulls the reference and keeps the comment', async () => {
    const t = await seedTenant(ctx.c, `del-${uuid()}`);
    const cid = await insertComment(ctx.c, t);
    await ctx.c.query('DELETE FROM author WHERE id = $1', [t.authorId]);
    const r = (
      await ctx.c.query('SELECT author_id, connection_id FROM comment WHERE id = $1', [cid])
    ).rows[0];
    expect(r).toEqual({ author_id: null, connection_id: t.connectionId });
  });
});

describe('content and time', () => {
  it('stores 1 MB of mixed scripts, emoji sequences and RTL text byte-for-byte', async () => {
    const chunk = 'Hello שלום مرحبا こんにちは 👩🏽‍💻🏳️‍🌈 é ‮abc ';
    const body = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const id = await insertComment(ctx.c, a, { body });
    const r = (
      await ctx.c.query('SELECT body, octet_length(body) AS n FROM comment WHERE id = $1', [id])
    ).rows[0];
    expect(r.body).toBe(body);
    expect(r.n).toBe(Buffer.byteLength(body));
  });

  it('rejects a NUL byte instead of truncating (the normalizer must strip it)', async () => {
    await expectPgError(insertComment(ctx.c, a, { body: 'before\u0000after' }), '22021');
  });

  it('keeps posted_at as the same instant regardless of input offset, and ingested_at is ours', async () => {
    const id = await insertComment(ctx.c, a, { postedAt: '2026-10-01T17:30:00+05:30' });
    const r = (await ctx.c.query('SELECT posted_at, ingested_at FROM comment WHERE id = $1', [id]))
      .rows[0];
    expect(r.posted_at.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(r.ingested_at.getTime()).toBeGreaterThan(r.posted_at.getTime());
  });

  it('platform_state is constrained', async () => {
    const id = await insertComment(ctx.c, a);
    await expectPgError(
      ctx.c.query("UPDATE comment SET platform_state = 'gone' WHERE id = $1", [id]),
      '23514',
      'comment_platform_state_check',
    );
  });
});

describe('lookups and deletion', () => {
  it('comments by organization and source, newest first, use the index', async () => {
    // Dropped inside a transaction (rolled back) so the planner cannot tie-break onto the
    // org-wide index; the plan must then come from the per-source composite index.
    let plan = '';
    await ctx.c.query('BEGIN');
    try {
      await ctx.c.query('DROP INDEX comment_organization_id_ingested_at_idx');
      await ctx.c.query('SET LOCAL enable_seqscan = off');
      plan = (
        await ctx.c.query(
          'EXPLAIN SELECT id FROM comment WHERE organization_id = $1 AND source_id = $2 ORDER BY ingested_at DESC, id DESC LIMIT 50',
          [a.organizationId, a.sourceId],
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
    } finally {
      await ctx.c.query('ROLLBACK');
    }
    expect(plan).toMatch(/comment_organization_id_source_id_ingested_at_idx/);
    expect(plan).not.toMatch(/Sort/);
  });

  it('deleting a source removes its comments only; authors stay', async () => {
    const t = await seedTenant(ctx.c, `src-${uuid()}`);
    await insertComment(ctx.c, t);
    const keep = await insertComment(ctx.c, t, { sourceId: t.otherSourceId });
    await ctx.c.query('DELETE FROM source WHERE id = $1', [t.sourceId]);
    expect(
      (await ctx.c.query('SELECT id FROM comment WHERE brand_id = $1', [t.brandId])).rows.map(
        (r) => r.id,
      ),
    ).toEqual([keep]);
    expect(
      (await ctx.c.query('SELECT count(*)::int AS n FROM author WHERE id = $1', [t.authorId]))
        .rows[0].n,
    ).toBe(1);
  });

  it('deleting a connection removes its sources, authors and comments', async () => {
    const t = await seedTenant(ctx.c, `conn-${uuid()}`);
    await insertComment(ctx.c, t);
    await ctx.c.query('DELETE FROM connection WHERE id = $1', [t.connectionId]);
    for (const tbl of ['source', 'author', 'comment'])
      expect(
        (
          await ctx.c.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE connection_id = $1`, [
            t.connectionId,
          ])
        ).rows[0].n,
        tbl,
      ).toBe(0);
  });
});
