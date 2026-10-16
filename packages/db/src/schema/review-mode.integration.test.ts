import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261016000400_review_mode';

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

async function suggestion(t: Tenant, commentId: string, status = 'pending'): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, author_id,
                                      body_sha256, status, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 = 'pending' THEN NULL ELSE now() END) RETURNING id`,
      [
        t.organizationId,
        t.brandId,
        t.connectionId,
        commentId,
        t.authorId,
        Buffer.alloc(32, 1),
        status,
      ],
    )
  ).rows[0]!.id;
}

function source(t: Tenant, suggestionId: string, type: string, ref: string, ruleId: string | null) {
  return c.query(
    `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref,
                                           rule_id, steps, reason)
     VALUES ($1,$2,$3,$4,$5,$6,'[{"type":"hide"}]','matched')`,
    [t.organizationId, t.brandId, suggestionId, type, ref, ruleId],
  );
}

async function connectionWindow(started: string, ends: string, mode = 'on') {
  const k = `acct-${uuid()}`;
  await c.query(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id,
                             review_mode, review_mode_started_at, review_mode_ends_at)
     VALUES ($1,$2,'instagram',$3,$4,$5::timestamptz,${ends})`,
    [a.organizationId, a.brandId, k, mode, started],
  );
}

describe('connection review-mode window', () => {
  it('existing activated connections are backfilled legacy; a never-activated oauth_pending row becomes on', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        expect((await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).status).toBe('rolled_back');
        const t = await seedTenant(k, 'bf');
        const ins = async (ext: string, status: string, reason: string | null) =>
          (
            await k.query<{ id: string }>(
              `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
               VALUES ($1,$2,'instagram',$3,$4,$5) RETURNING id`,
              [t.organizationId, t.brandId, ext, status, reason],
            )
          ).rows[0]!.id;
        const activated = await ins('act', 'reconnect_required', 'oauth_pending');
        await k.query(
          `INSERT INTO audit_event (organization_id, actor_type, action, subject_type, subject_id)
           VALUES ($1,'system','connection.authorized','connection',$2)`,
          [t.organizationId, activated],
        );
        const never = await ins('never', 'reconnect_required', 'oauth_pending');
        const plain = await ins('plain', 'active', null);
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        const rows = await k.query<{ id: string; review_mode: string }>(
          'SELECT id, review_mode FROM connection WHERE id = ANY($1)',
          [[t.connectionId, activated, never, plain]],
        );
        const mode = Object.fromEntries(rows.rows.map((r) => [r.id, r.review_mode]));
        expect(mode).toEqual({
          [t.connectionId]: 'legacy',
          [activated]: 'legacy',
          [plain]: 'legacy',
          [never]: 'on',
        });
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });

  it('new connection rows default to review_mode on with no window yet', async () => {
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
         VALUES ($1,$2,'instagram',$3) RETURNING id`,
        [a.organizationId, a.brandId, `acct-${uuid()}`],
      )
    ).rows[0]!.id;
    const r = (
      await c.query(
        `SELECT review_mode, review_mode_started_at, review_mode_ends_at, review_mode_ended_at,
                review_mode_ended_by_user_id FROM connection WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(r).toEqual({
      review_mode: 'on',
      review_mode_started_at: null,
      review_mode_ends_at: null,
      review_mode_ended_at: null,
      review_mode_ended_by_user_id: null,
    });
  });

  it('window must be exactly 168 hours', async () => {
    await c.query("SET TIME ZONE 'Europe/Berlin'");
    try {
      await expectPgError(
        connectionWindow(
          '2026-10-20T10:00Z',
          "'2026-10-20T10:00Z'::timestamptz + interval '7 days'",
        ),
        '23514',
        'connection_review_mode_window_check',
      );
      await connectionWindow(
        '2026-10-20T10:00Z',
        "'2026-10-20T10:00Z'::timestamptz + interval '168 hours'",
      );
      const { rows } = await c.query(
        `SELECT extract(epoch from review_mode_ends_at - review_mode_started_at)::int AS secs
           FROM connection WHERE review_mode_started_at = '2026-10-20T10:00Z' AND brand_id = $1`,
        [a.brandId],
      );
      expect(rows.map((r) => r.secs)).toEqual([604800]);
    } finally {
      await c.query('RESET TIME ZONE');
    }
  });

  it('window start and end come as a pair', async () => {
    await expectPgError(
      connectionWindow('2026-10-20T10:00Z', 'NULL'),
      '23514',
      'connection_review_mode_window_check',
    );
  });

  it('legacy and opted_out rows cannot carry a window', async () => {
    for (const mode of ['legacy', 'opted_out'])
      await expectPgError(
        connectionWindow('2026-10-20T10:00Z', "'2026-10-27T10:00Z'::timestamptz", mode),
        '23514',
        'connection_review_mode_started_check',
      );
  });

  it('ending early needs mode on and a started window', async () => {
    await expectPgError(
      c.query('UPDATE connection SET review_mode_ended_at = now() WHERE id = $1', [a.connectionId]),
      '23514',
      'connection_review_mode_ended_check',
    );
  });

  it('rejects an unknown review_mode', async () => {
    await expectPgError(
      c.query("UPDATE connection SET review_mode = 'maybe' WHERE id = $1", [a.connectionId]),
      '23514',
      'connection_review_mode_check',
    );
  });
});

describe('action_suggestion', () => {
  it('one pending suggestion per comment; a second is allowed after the first is dismissed', async () => {
    const cm = await comment(a);
    const first = await suggestion(a, cm);
    await expectPgError(suggestion(a, cm), '23505', 'action_suggestion_pending_comment_key');
    await c.query(
      "UPDATE action_suggestion SET status = 'dismissed', decided_at = now() WHERE id = $1",
      [first],
    );
    await suggestion(a, cm);
  });

  it('status, decided_at and request_key are consistent', async () => {
    const cm = await comment(a);
    await expectPgError(suggestion(a, cm, 'bogus'), '23514', 'action_suggestion_status_check');
    const id = await suggestion(a, cm);
    await expectPgError(
      c.query("UPDATE action_suggestion SET status = 'approved' WHERE id = $1", [id]),
      '23514',
      'action_suggestion_decided_check',
    );
    await expectPgError(
      c.query("UPDATE action_suggestion SET request_key = 'k' WHERE id = $1", [id]),
      '23514',
      'action_suggestion_request_key_check',
    );
    await expectPgError(
      c.query("UPDATE action_suggestion SET status_reason = 'Bad Reason' WHERE id = $1", [id]),
      '23514',
      'action_suggestion_status_reason_check',
    );
  });

  it('cross-tenant FK: suggestion for brand A pointing at brand B comment', async () => {
    const other = await comment(b);
    await expectPgError(
      c.query(
        `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256)
         VALUES ($1,$2,$3,$4,$5)`,
        [a.organizationId, a.brandId, a.connectionId, other, Buffer.alloc(32, 1)],
      ),
      '23503',
      'action_suggestion_comment_id_fkey',
    );
  });
});

describe('action_suggestion consistency', () => {
  it('the comment must belong to the suggestion connection', async () => {
    const other = (
      await c.query<{ id: string }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
         VALUES ($1,$2,'instagram',$3) RETURNING id`,
        [a.organizationId, a.brandId, `acct-${uuid()}`],
      )
    ).rows[0]!.id;
    const cm = await comment(a);
    await expectPgError(
      c.query(
        `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256)
         VALUES ($1,$2,$3,$4,$5)`,
        [a.organizationId, a.brandId, other, cm, Buffer.alloc(32, 1)],
      ),
      '23514',
    );
    const id = await suggestion(a, cm);
    await expectPgError(
      c.query('UPDATE action_suggestion SET connection_id = $2 WHERE id = $1', [id, other]),
      '23514',
    );
  });
});

describe('action_suggestion_source', () => {
  it('source unique per (suggestion, type, ref)', async () => {
    const s = await suggestion(a, await comment(a));
    const ref = uuid();
    await source(a, s, 'classifier', ref, null);
    await expectPgError(
      source(a, s, 'classifier', ref, null),
      '23505',
      'action_suggestion_source_ref_key',
    );
    await source(a, s, 'policy', ref, null);
  });

  it('rule source requires rule_id; classifier source forbids it', async () => {
    const s = await suggestion(a, await comment(a));
    await expectPgError(
      source(a, s, 'rule', a.ruleId, null),
      '23514',
      'action_suggestion_source_rule_id_check',
    );
    await expectPgError(
      source(a, s, 'classifier', uuid(), a.ruleId),
      '23514',
      'action_suggestion_source_rule_id_check',
    );
    await source(a, s, 'rule', a.ruleId, a.ruleId);
  });

  it('bounds steps and also_matched_rule_ids', async () => {
    const s = await suggestion(a, await comment(a));
    await expectPgError(
      c.query(
        `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref, steps, reason)
         VALUES ($1,$2,$3,'policy',$4,'[]','r')`,
        [a.organizationId, a.brandId, s, uuid()],
      ),
      '23514',
      'action_suggestion_source_steps_check',
    );
    await expectPgError(
      c.query(
        `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref, steps, reason, also_matched_rule_ids)
         VALUES ($1,$2,$3,'policy',$4,'[{"type":"hide"}]','r', ARRAY(SELECT gen_random_uuid() FROM generate_series(1,51)))`,
        [a.organizationId, a.brandId, s, uuid()],
      ),
      '23514',
      'action_suggestion_source_also_matched_rule_ids_check',
    );
  });
});

describe('action_run origin', () => {
  const insert = (t: Tenant, commentId: string, cols: string, vals: unknown[]) =>
    c.query(
      `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, dry_run, ${cols})
       VALUES ($1,$2,$3,$4,false, ${vals.map((_, i) => `$${i + 5}`).join(',')})`,
      [t.organizationId, t.brandId, t.connectionId, commentId, ...vals],
    );

  it('requires either (rule_id, evaluation) or suggestion_id, not both', async () => {
    const cm = await comment(a);
    const ev = (
      await c.query<{ id: string }>(
        `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                      trigger_key, ruleset_version, status)
         VALUES ($1,$2,$3,$4,$5,'t','v1','no_match') RETURNING id`,
        [a.organizationId, a.brandId, a.connectionId, cm, Buffer.alloc(32, 7)],
      )
    ).rows[0]!.id;
    const s = await suggestion(a, cm);
    await expectPgError(insert(a, cm, 'rule_id', [a.ruleId]), '23514', 'action_run_origin_check');
    await expectPgError(
      insert(a, cm, 'rule_id, rule_evaluation_id, suggestion_id', [a.ruleId, ev, s]),
      '23514',
      'action_run_origin_check',
    );
    await expectPgError(
      insert(a, cm, 'approved_by_user_id', [a.userId]),
      '23514',
      'action_run_approver_check',
    );
    await expectPgError(
      insert(a, cm, 'suggestion_id, rule_id', [s, a.ruleId]),
      '23514',
      'action_run_origin_check',
    );
    await expectPgError(
      insert(a, cm, 'suggestion_id, rule_evaluation_id', [s, ev]),
      '23514',
      'action_run_origin_check',
    );
    await expectPgError(
      insert(a, cm, 'rule_id, rule_evaluation_id, approved_by_user_id', [a.ruleId, ev, a.userId]),
      '23514',
      'action_run_approver_check',
    );
    await insert(a, cm, 'rule_id, rule_evaluation_id', [a.ruleId, ev]);
    await insert(a, cm, 'suggestion_id, approved_by_user_id', [s, a.userId]);
    await expectPgError(insert(a, cm, 'suggestion_id', [s]), '23505', 'action_run_suggestion_key');
  });

  it("a suggestion run must be for the suggestion's own comment", async () => {
    const s = await suggestion(a, await comment(a));
    await expectPgError(
      insert(a, await comment(a), 'suggestion_id', [s]),
      '23503',
      'action_run_suggestion_comment_fkey',
    );
  });

  it('evaluation snapshots carry review_mode and the also-matched rules', async () => {
    for (const t of ['rule_evaluation', 'comment_classification', 'policy_evaluation']) {
      const { rows } = await c.query(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'review_mode' AND is_nullable = 'NO'`,
        [t],
      );
      expect(rows, t).toEqual([{ column_default: 'false' }]);
    }
    const { rows } = await c.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'rule_evaluation' AND column_name = 'also_matched_rule_ids' AND is_nullable = 'NO'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('bounds rule_evaluation.also_matched_rule_ids', async () => {
    const cm = await comment(a);
    const ins = (n: number) =>
      c.query(
        `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                      trigger_key, ruleset_version, status, also_matched_rule_ids)
         VALUES ($1,$2,$3,$4,$5,$6,'v1','no_match', ARRAY(SELECT gen_random_uuid() FROM generate_series(1,$7::int)))`,
        [a.organizationId, a.brandId, a.connectionId, cm, Buffer.alloc(32, 9), `k-${uuid()}`, n],
      );
    await expectPgError(ins(51), '23514', 'rule_evaluation_also_matched_rule_ids_check');
    await ins(50);
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
        // A suggestion-origin run must not block restoring NOT NULL.
        const t = await seedTenant(k, 'dn', { reviewMode: 'on' });
        const cm = (
          await k.query<{ id: string }>(
            `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
             VALUES ($1,$2,$3,$4,'c','text', now()) RETURNING id`,
            [t.organizationId, t.brandId, t.connectionId, t.sourceId],
          )
        ).rows[0]!.id;
        const s = (
          await k.query<{ id: string }>(
            `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, body_sha256)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [t.organizationId, t.brandId, t.connectionId, cm, Buffer.alloc(32, 1)],
          )
        ).rows[0]!.id;
        await k.query(
          `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, dry_run, suggestion_id)
           VALUES ($1,$2,$3,$4,false,$5)`,
          [t.organizationId, t.brandId, t.connectionId, cm, s],
        );
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        expect(down).not.toContain('action_suggestion');
        expect(down).not.toContain('review_mode');
        expect(down).not.toContain('also_matched_rule_ids');
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
