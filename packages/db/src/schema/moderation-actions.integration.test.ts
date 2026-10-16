import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { makeMigrationsDir } from '../testing/migration-fixtures.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261016000300_moderation_actions';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
  a = await seedTenant(c, 'a');
  b = await seedTenant(c, 'b');
});
afterAll(() => ctx.close());

async function comment(t: Tenant): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
       VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
    )
  ).rows[0]!.id;
}

async function decide(t: Tenant, commentId: string, mode: 'enforce' | 'suggest'): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id, reason)
       VALUES ($1,$2,$3,'flag',$4,'rule',$5,'matched') RETURNING id`,
      [t.organizationId, t.brandId, commentId, mode, t.ruleId],
    )
  ).rows[0]!.id;
}

async function evaluation(t: Tenant, commentId: string): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                    trigger_key, ruleset_version, status)
       VALUES ($1,$2,$3,$4,$5,$6,'v1','no_match') RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, commentId, Buffer.alloc(32, 7), `t-${uuid()}`],
    )
  ).rows[0]!.id;
}

async function run(t: Tenant): Promise<string> {
  const commentId = await comment(t);
  const evalId = await evaluation(t, commentId);
  return (
    await c.query<{ id: string }>(
      `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
       VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, commentId, t.ruleId, evalId],
    )
  ).rows[0]!.id;
}

const step = (
  t: Tenant,
  runId: string,
  o: { brand?: string; status?: string; completed?: string } = {},
) =>
  c.query(
    `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, status, completed_at)
     VALUES ($1,$2,$3,0,'hide','{}'::jsonb,$4,${o.completed ?? 'NULL'})`,
    [t.organizationId, o.brand ?? t.brandId, runId, o.status ?? 'pending'],
  );

describe('rule.actions', () => {
  it('seeded rule has the hide step', async () => {
    const r = await c.query('SELECT actions FROM rule WHERE id = $1', [a.ruleId]);
    expect(r.rows[0].actions).toEqual([{ type: 'hide' }]);
  });

  it('backfills rule.actions from rule.action', async () => {
    const db = await createScratchDatabase(adminUrl());
    const all = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
    const before = await makeMigrationsDir(all.filter((d) => d < MIGRATION));
    try {
      expect(
        (await runPrisma(['migrate', 'deploy'], db.url, { migrationsDir: before.relDir })).code,
      ).toBe(0);
      const k = await db.client();
      try {
        const t = await seedTenant(k, 'legacy');
        const ids: Record<string, string> = {};
        for (const action of ['approve', 'hide', 'remove', 'flag']) {
          ids[action] = (
            await k.query<{ id: string }>(
              `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
               VALUES ($1,$2,$3,'{"type":"keyword","terms":["x"]}',$3) RETURNING id`,
              [t.organizationId, t.brandId, action],
            )
          ).rows[0]!.id;
        }
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        const got = async (id: string) =>
          (await k.query('SELECT actions FROM rule WHERE id = $1', [id])).rows[0].actions;
        expect(await got(ids.approve!)).toEqual([]);
        expect(await got(ids.hide!)).toEqual([{ type: 'hide' }]);
        expect(await got(ids.remove!)).toEqual([{ type: 'delete', confirmIrreversible: true }]);
        expect(await got(ids.flag!)).toEqual([{ type: 'flag_for_review' }]);
        expect(await got(t.ruleId)).toEqual([{ type: 'hide' }]);
      } finally {
        await k.end();
      }
    } finally {
      await before.cleanup();
      await db.drop();
    }
  });

  it('defaults to an empty array', async () => {
    const r = await c.query(
      `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
       VALUES ($1,$2,'d','{}','hide') RETURNING actions`,
      [a.organizationId, a.brandId],
    );
    expect(r.rows[0].actions).toEqual([]);
  });

  it('rejects actions that are not an array or longer than 6', async () => {
    await expectPgError(
      c.query(`UPDATE rule SET actions = '{}'::jsonb WHERE id = $1`, [a.ruleId]),
      '23514',
      'rule_actions_check',
    );
    await expectPgError(
      c.query(`UPDATE rule SET actions = '[1,2,3,4,5,6,7]'::jsonb WHERE id = $1`, [a.ruleId]),
      '23514',
      'rule_actions_check',
    );
    await c.query(`UPDATE rule SET actions = '[1,2,3,4,5,6]'::jsonb WHERE id = $1`, [a.ruleId]);
    await c.query(`UPDATE rule SET actions = '[{"type":"hide"}]'::jsonb WHERE id = $1`, [a.ruleId]);
  });
});

describe('review_item', () => {
  const open = async (commentId: string) =>
    (
      await c.query("SELECT * FROM review_item WHERE comment_id = $1 AND status = 'open'", [
        commentId,
      ])
    ).rows;

  it('flag enforce decision opens exactly one review item; suggest decision opens none', async () => {
    const one = await comment(a);
    await decide(a, one, 'enforce');
    await decide(a, one, 'enforce');
    const items = await open(one);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('rule');
    expect(items[0].rule_id).toBe(a.ruleId);
    expect(items[0].connection_id).toBe(a.connectionId);
    const two = await comment(a);
    await decide(a, two, 'suggest');
    expect(await open(two)).toHaveLength(0);
  });

  it('second open item for a comment is rejected; a new one is allowed after resolve', async () => {
    const id = await comment(a);
    const ins = () =>
      c.query(
        `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
         VALUES ($1,$2,$3,$4,'user')`,
        [a.organizationId, a.brandId, a.connectionId, id],
      );
    await ins();
    await expectPgError(ins(), '23505', 'review_item_open_comment_key');
    await c.query(
      `UPDATE review_item SET status = 'resolved', resolution = 'approved', resolved_at = now() WHERE comment_id = $1`,
      [id],
    );
    await ins();
    expect(await open(id)).toHaveLength(1);
  });

  it('resolution and status must agree', async () => {
    const id = await comment(a);
    await expectPgError(
      c.query(
        `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source, status)
         VALUES ($1,$2,$3,$4,'user','resolved')`,
        [a.organizationId, a.brandId, a.connectionId, id],
      ),
      '23514',
    );
  });

  it('review item cannot point at a comment of another brand', async () => {
    const id = await comment(b);
    await expectPgError(
      c.query(
        `INSERT INTO review_item (organization_id, brand_id, connection_id, comment_id, source)
         VALUES ($1,$2,$3,$4,'user')`,
        [a.organizationId, a.brandId, a.connectionId, id],
      ),
      '23503',
    );
  });
});

describe('action_run_step', () => {
  it('step status/completed_at and undo pairing checks', async () => {
    const r = await run(a);
    await expectPgError(step(a, r, { status: 'succeeded' }), '23514');
    await expectPgError(step(a, r, { status: 'pending', completed: 'now()' }), '23514');
    await expectPgError(
      c.query(
        `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, undone_at)
         VALUES ($1,$2,$3,0,'hide','{}', now())`,
        [a.organizationId, a.brandId, r],
      ),
      '23514',
    );
    await expectPgError(
      c.query(
        `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config, preview_text)
         VALUES ($1,$2,$3,0,'hide','{}', 'x')`,
        [a.organizationId, a.brandId, r],
      ),
      '23514',
    );
    await step(a, r, { status: 'succeeded', completed: 'now()' });
  });

  it('one step per type and position within a run', async () => {
    const r = await run(a);
    await step(a, r);
    await expectPgError(step(a, r), '23505');
  });

  it('one run per evaluation and rule', async () => {
    const commentId = await comment(a);
    const evalId = await evaluation(a, commentId);
    const ins = () =>
      c.query(
        `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [a.organizationId, a.brandId, a.connectionId, commentId, a.ruleId, evalId],
      );
    await ins();
    await expectPgError(ins(), '23505', 'action_run_evaluation_rule_key');
  });

  it('cross-tenant FK', async () => {
    const runB = await run(b);
    await expectPgError(step(a, runB), '23503');
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
        const prev = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        // Migrations added after this one are rolled back first.
        for (const later of prev.slice(prev.indexOf(MIGRATION) + 1).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: later,
          });
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        expect(down).not.toContain('action_run');
        expect(down).not.toContain('review_item');
        expect(down).not.toContain('col rule.actions');
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
