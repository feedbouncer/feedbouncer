import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261017000100_inbox_triage';
const TABLES = ['tag', 'comment_tag', 'comment_done', 'role_grant'];

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0]!.id;
const insertTag = (t: Tenant, name: string, key = name.toLowerCase()) =>
  id('INSERT INTO tag (organization_id, name, name_key) VALUES ($1, $2, $3) RETURNING id', [
    t.organizationId,
    name,
    key,
  ]);
const insertComment = (t: Tenant) =>
  id(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, 'text', now()) RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
  );
const linkTag = (t: Tenant, commentId: string, tagId: string) =>
  c.query(
    'INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id) VALUES ($1, $2, $3, $4)',
    [t.organizationId, t.brandId, commentId, tagId],
  );
const markDone = (t: Tenant, commentId: string) =>
  c.query('INSERT INTO comment_done (organization_id, brand_id, comment_id) VALUES ($1, $2, $3)', [
    t.organizationId,
    t.brandId,
    commentId,
  ]);
const count = async (table: string, where: string, v: unknown[]) =>
  Number(
    (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, v)).rows[0]!
      .n,
  );

describe('tag', () => {
  it("name rejects '', ' x', 51 chars; accepts 50 emoji", async () => {
    const t = await seedTenant(c, 'tag-name');
    for (const bad of ['', ' x', 'x ', 'a'.repeat(51)])
      await expectPgError(insertTag(t, bad, 'k'), '23514', 'tag_name_check');
    await expectPgError(insertTag(t, 'ok', ''), '23514', 'tag_name_key_check');
    await insertTag(t, '😀'.repeat(50), 'emoji');
  });

  it('name_key is unique per org, not across orgs', async () => {
    const a = await seedTenant(c, 'tag-a');
    const b = await seedTenant(c, 'tag-b');
    await insertTag(a, 'Refund', 'refund');
    await expectPgError(
      insertTag(a, 'REFUND', 'refund'),
      '23505',
      'tag_organization_id_name_key_key',
    );
    await insertTag(b, 'Refund', 'refund');
  });
});

describe('comment_tag and comment_done', () => {
  it('comment_tag cannot link an org A comment to an org B tag', async () => {
    const a = await seedTenant(c, 'link-a');
    const b = await seedTenant(c, 'link-b');
    const tagB = await insertTag(b, 'Other');
    await expectPgError(
      linkTag(a, await insertComment(a), tagB),
      '23503',
      'comment_tag_tag_id_fkey',
    );
  });

  it('comment_tag cannot point at a comment of another brand', async () => {
    const a = await seedTenant(c, 'brand-a');
    const b = await seedTenant(c, 'brand-b');
    const tag = await insertTag(a, 'Mine');
    await expectPgError(
      c.query(
        'INSERT INTO comment_tag (organization_id, brand_id, comment_id, tag_id) VALUES ($1, $2, $3, $4)',
        [a.organizationId, a.brandId, await insertComment(b), tag],
      ),
      '23503',
      'comment_tag_comment_id_fkey',
    );
  });

  it('rows cascade when the comment, the tag or the brand is deleted', async () => {
    const t = await seedTenant(c, 'cascade');
    const tagKeep = await insertTag(t, 'Keep');
    const tagGone = await insertTag(t, 'Gone');
    const [c1, c2] = [await insertComment(t), await insertComment(t)];
    await linkTag(t, c1, tagKeep);
    await linkTag(t, c1, tagGone);
    await linkTag(t, c2, tagKeep);
    await markDone(t, c1);
    await markDone(t, c2);

    await c.query('DELETE FROM tag WHERE id = $1', [tagGone]);
    expect(await count('comment_tag', 'comment_id = $1', [c1])).toBe(1);

    await c.query('DELETE FROM comment WHERE id = $1', [c1]);
    expect(await count('comment_tag', 'comment_id = $1', [c1])).toBe(0);
    expect(await count('comment_done', 'comment_id = $1', [c1])).toBe(0);
    expect(await count('comment_done', 'comment_id = $1', [c2])).toBe(1);

    await c.query('DELETE FROM brand WHERE id = $1', [t.brandId]);
    expect(await count('comment_tag', 'organization_id = $1', [t.organizationId])).toBe(0);
    expect(await count('comment_done', 'organization_id = $1', [t.organizationId])).toBe(0);
    expect(await count('tag', 'organization_id = $1', [t.organizationId])).toBe(1);
  });

  it('a user delete keeps the rows and nulls the actor', async () => {
    const t = await seedTenant(c, 'actor');
    const user = await id('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
      `actor-${uuid()}@example.test`,
    ]);
    const comment = await insertComment(t);
    await c.query(
      'INSERT INTO comment_done (organization_id, brand_id, comment_id, done_by_user_id) VALUES ($1, $2, $3, $4)',
      [t.organizationId, t.brandId, comment, user],
    );
    await c.query('DELETE FROM app_user WHERE id = $1', [user]);
    const row = (
      await c.query('SELECT done_by_user_id FROM comment_done WHERE comment_id = $1', [comment])
    ).rows[0];
    expect(row).toEqual({ done_by_user_id: null });
  });
});

describe('role_grant', () => {
  it('accepts only (member, comment.reply)', async () => {
    const t = await seedTenant(c, 'grant');
    const grant = (role: string, capability: string) =>
      c.query('INSERT INTO role_grant (organization_id, role, capability) VALUES ($1, $2, $3)', [
        t.organizationId,
        role,
        capability,
      ]);
    await expectPgError(grant('admin', 'comment.reply'), '23514', 'role_grant_grantable_check');
    await expectPgError(grant('member', 'rule.write'), '23514', 'role_grant_grantable_check');
    await grant('member', 'comment.reply');
    await expectPgError(grant('member', 'comment.reply'), '23505', 'role_grant_pkey');
  });
});

describe('down.sql', () => {
  it('reverts cleanly and re-applies', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const applied = await snapshotSchema(k);
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        // Migrations added after this one are rolled back first.
        for (const later of dirs.slice(dirs.indexOf(MIGRATION) + 1).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: later,
          });
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        for (const table of TABLES) expect(down).not.toMatch(new RegExp(`\\b${table}\\.`));
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        expect(await snapshotSchema(k)).toEqual(applied);
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });
});
