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

async function comment(c: pg.ClientBase, t: Tenant): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
     VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
      [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
    )
  ).rows[0]!.id;
}
type D = Partial<{
  org: string;
  brand: string;
  outcome: string;
  actorType: string;
  userId: string | null;
  ruleId: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
  reason: string;
  mode: string;
}>;
async function decide(c: pg.ClientBase, t: Tenant, commentId: string, d: D = {}): Promise<string> {
  const actorType = d.actorType ?? 'user';
  return (
    await c.query<{ id: string }>(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, rule_id,
                           classifier_provider, classifier_model, confidence, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        d.org ?? t.organizationId,
        d.brand ?? t.brandId,
        commentId,
        d.outcome ?? 'hide',
        d.mode ?? 'enforce',
        actorType,
        d.userId !== undefined ? d.userId : actorType === 'user' ? t.userId : null,
        d.ruleId !== undefined ? d.ruleId : actorType === 'rule' ? t.ruleId : null,
        d.provider !== undefined ? d.provider : actorType === 'classifier' ? 'anthropic' : null,
        d.model !== undefined ? d.model : actorType === 'classifier' ? 'claude-haiku' : null,
        d.confidence ?? null,
        d.reason ?? 'Matched rule: scam link',
      ],
    )
  ).rows[0]!.id;
}
const LATEST =
  'SELECT id, outcome FROM decision WHERE comment_id = $1 AND brand_id = $2 ORDER BY sequence DESC LIMIT 1';

describe('decision history', () => {
  it('keeps every decision and returns the newest as latest (hide, then restore)', async () => {
    const cid = await comment(ctx.c, a);
    const hide = await decide(ctx.c, a, cid, { outcome: 'hide', actorType: 'rule' });
    const restore = await decide(ctx.c, a, cid, {
      outcome: 'approve',
      actorType: 'user',
      reason: 'False positive: real complaint',
    });
    expect((await ctx.c.query(LATEST, [cid, a.brandId])).rows[0]).toEqual({
      id: restore,
      outcome: 'approve',
    });
    expect(
      (
        await ctx.c.query('SELECT id FROM decision WHERE comment_id = $1 ORDER BY sequence', [cid])
      ).rows.map((r) => r.id),
    ).toEqual([hide, restore]);
  });

  it('two decisions in one transaction still have a strict order', async () => {
    const cid = await comment(ctx.c, a);
    await ctx.c.query('BEGIN');
    await decide(ctx.c, a, cid, { outcome: 'flag' });
    const second = await decide(ctx.c, a, cid, { outcome: 'remove' });
    await ctx.c.query('COMMIT');
    expect((await ctx.c.query(LATEST, [cid, a.brandId])).rows[0].id).toBe(second);
  });

  it('the latest-decision query is an index scan without a sort', async () => {
    const cid = await comment(ctx.c, a);
    await ctx.c.query('SET enable_seqscan = off');
    const plan = (await ctx.c.query(`EXPLAIN ${LATEST}`, [cid, a.brandId])).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    await ctx.c.query('RESET enable_seqscan');
    expect(plan).toMatch(/decision_comment_id_sequence_idx/);
    expect(plan).not.toMatch(/Sort/);
  });

  it('decisions cannot be updated, deleted or truncated directly', async () => {
    const id = await decide(ctx.c, a, await comment(ctx.c, a));
    await expectPgError(
      ctx.c.query("UPDATE decision SET reason = 'rewritten' WHERE id = $1", [id]),
      '23001',
    );
    await expectPgError(ctx.c.query('DELETE FROM decision WHERE id = $1', [id]), '23001');
    await expectPgError(ctx.c.query('TRUNCATE decision'), '23001');
  });
});

describe('actor and explanation', () => {
  it.each([
    [{ actorType: 'rule', ruleId: null }, 'decision_actor_check'],
    [{ actorType: 'classifier', provider: null }, 'decision_actor_check'],
    [{ actorType: 'user', ruleId: 'RULE' }, 'decision_actor_check'],
    [{ actorType: 'robot' }, null],
    [{ outcome: 'shadowban' }, 'decision_outcome_check'],
    [{ reason: '  ' }, 'decision_reason_check'],
    [{ actorType: 'classifier', confidence: 1.5 }, 'decision_confidence_check'],
  ] as const)('rejects %j', async (d, constraint) => {
    const cid = await comment(ctx.c, a);
    const fixed = {
      ...d,
      ...('ruleId' in d && d.ruleId === 'RULE' ? { ruleId: a.ruleId } : {}),
    } as D;
    await expectPgError(decide(ctx.c, a, cid, fixed), '23514', constraint ?? undefined);
  });

  it('a user decision must name the user when inserted', async () => {
    await expectPgError(
      decide(ctx.c, a, await comment(ctx.c, a), { actorType: 'user', userId: null }),
      '23502',
    );
  });

  it('any provider and model string is accepted (no vendor lock-in)', async () => {
    await decide(ctx.c, a, await comment(ctx.c, a), {
      actorType: 'classifier',
      provider: 'ollama',
      model: 'qwen3guard:8b',
      confidence: 0.91,
    });
  });
});

describe('cross-tenant isolation', () => {
  it("a decision cannot reference another brand's comment", async () => {
    await expectPgError(
      decide(ctx.c, a, await comment(ctx.c, b)),
      '23503',
      'decision_brand_id_comment_id_fkey',
    );
  });
  it("a decision cannot cite another brand's rule", async () => {
    const cid = await comment(ctx.c, a);
    await ctx.c.query('BEGIN');
    try {
      await decide(ctx.c, a, cid, { actorType: 'rule', ruleId: b.ruleId });
      await expectPgError(ctx.c.query('COMMIT'), '23503', 'decision_brand_id_rule_id_fkey');
    } finally {
      await ctx.c.query('ROLLBACK').catch(() => {});
    }
  });
  it("a rule cannot be created under another organization's brand", async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO rule (organization_id, brand_id, name, conditions, action) VALUES ($1,$2,'x','{}','flag')",
        [a.organizationId, b.brandId],
      ),
      '23503',
      'rule_organization_id_brand_id_fkey',
    );
  });
});

describe('deletion and erasure', () => {
  it('a rule cited by a decision cannot be deleted directly; disabling works', async () => {
    const t = await seedTenant(ctx.c, `rule-${uuid()}`);
    await decide(ctx.c, t, await comment(ctx.c, t), { actorType: 'rule' });
    await expectPgError(
      ctx.c.query('DELETE FROM rule WHERE id = $1', [t.ruleId]),
      '23503',
      'decision_brand_id_rule_id_fkey',
    );
    await ctx.c.query('UPDATE rule SET enabled = false WHERE id = $1', [t.ruleId]);
  });

  it('deleting a brand removes its rules and decisions even when rules are cited', async () => {
    const t = await seedTenant(ctx.c, `brand-${uuid()}`);
    await decide(ctx.c, t, await comment(ctx.c, t), { actorType: 'rule' });
    await ctx.c.query('DELETE FROM brand WHERE id = $1', [t.brandId]);
    for (const tbl of ['rule', 'decision', 'comment'])
      expect(
        (
          await ctx.c.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE brand_id = $1`, [
            t.brandId,
          ])
        ).rows[0].n,
        tbl,
      ).toBe(0);
  });

  it('deleting a comment removes its decisions (cascade passes the append-only guard)', async () => {
    const cid = await comment(ctx.c, a);
    await decide(ctx.c, a, cid);
    await ctx.c.query('DELETE FROM comment WHERE id = $1', [cid]);
    expect(
      (await ctx.c.query('SELECT count(*)::int AS n FROM decision WHERE comment_id = $1', [cid]))
        .rows[0].n,
    ).toBe(0);
  });

  it('erasing a user keeps their decisions with actor_user_id NULL', async () => {
    const t = await seedTenant(ctx.c, `user-${uuid()}`);
    const did = await decide(ctx.c, t, await comment(ctx.c, t), { actorType: 'user' });
    await ctx.c.query('DELETE FROM app_user WHERE id = $1', [t.userId]);
    expect(
      (await ctx.c.query('SELECT actor_type, actor_user_id FROM decision WHERE id = $1', [did]))
        .rows[0],
    ).toEqual({ actor_type: 'user', actor_user_id: null });
  });
});
