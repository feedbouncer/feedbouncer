import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/index.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let t: Tenant;
let other: Tenant;

beforeAll(async () => {
  ctx = await migratedDb();
  t = await seedTenant(ctx.c, 'pol-a');
  other = await seedTenant(ctx.c, 'pol-b');
});
afterAll(() => ctx.close());

async function policy(tn: Tenant, name = `p-${uuid().slice(0, 8)}`) {
  const p = await ctx.c.query<{ id: string }>(
    `INSERT INTO custom_policy (organization_id, brand_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [tn.organizationId, tn.brandId, name],
  );
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO custom_policy_revision (organization_id, brand_id, policy_id, revision, text, action, vague)
     VALUES ($1, $2, $3, 1, 'hide comments telling people to DM another account', 'hide', false) RETURNING id`,
    [tn.organizationId, tn.brandId, p.rows[0]!.id],
  );
  return { policyId: p.rows[0]!.id, revisionId: r.rows[0]!.id };
}

async function comment(tn: Tenant) {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'dm @x for profit', now()) RETURNING id`,
    [tn.organizationId, tn.brandId, tn.connectionId, tn.sourceId, tn.authorId, `c-${uuid()}`],
  );
  return r.rows[0]!.id;
}

async function evaluation(tn: Tenant, commentId: string, revisionId: string | null) {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key,
       status, provider, model, prompt_version, outcome, winning_revision_id, checked_revision_ids, input_truncated, low_signal)
     VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'evaluated', 'openai', 'gpt-x', 'pol-v1',
       $5, $6, ARRAY[$6]::uuid[], false, false) RETURNING id`,
    [tn.organizationId, tn.brandId, tn.connectionId, commentId, revisionId ? 'hide' : null, revisionId],
  );
  return r.rows[0]!.id;
}

describe('custom_policy_revision', () => {
  it('is append-only', async () => {
    const { revisionId } = await policy(t);
    await expectPgError(ctx.c.query(`UPDATE custom_policy_revision SET text = 'x' WHERE id = $1`, [revisionId]), '23001');
    await expectPgError(ctx.c.query(`DELETE FROM custom_policy_revision WHERE id = $1`, [revisionId]), '23001');
  });
  it('rejects approve, short text and revision 0', async () => {
    const { policyId } = await policy(t);
    const ins = (rev: number, text: string, action: string) =>
      ctx.c.query(
        `INSERT INTO custom_policy_revision (organization_id, brand_id, policy_id, revision, text, action, vague)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [t.organizationId, t.brandId, policyId, rev, text, action],
      );
    await expectPgError(ins(2, 'long enough text', 'approve'), '23514', 'custom_policy_revision_action_check');
    await expectPgError(ins(2, 'short', 'flag'), '23514', 'custom_policy_revision_text_check');
    await expectPgError(ins(0, 'long enough text', 'flag'), '23514', 'custom_policy_revision_revision_check');
    await expectPgError(ins(1, 'long enough text', 'flag'), '23505', 'custom_policy_revision_policy_id_revision_key');
  });
  it('cannot point at another brand\'s policy', async () => {
    const { policyId } = await policy(other);
    await expectPgError(
      ctx.c.query(
        `INSERT INTO custom_policy_revision (organization_id, brand_id, policy_id, revision, text, action, vague)
         VALUES ($1, $2, $3, 2, 'long enough text', 'flag', false)`,
        [t.organizationId, t.brandId, policyId],
      ),
      '23503',
    );
  });
});

describe('custom_policy', () => {
  it('names are unique per brand among non-archived policies, case-insensitively', async () => {
    await policy(t, 'No DMs');
    await expectPgError(policy(t, 'no dms'), '23505', 'custom_policy_brand_id_name_key');
    await ctx.c.query(`UPDATE custom_policy SET enabled = false, archived_at = now() WHERE brand_id = $1 AND name = 'No DMs'`, [t.brandId]);
    await expect(policy(t, 'no dms')).resolves.toBeTruthy();
  });
  it('an archived policy cannot be enabled', async () => {
    const { policyId } = await policy(t);
    await expectPgError(
      ctx.c.query(`UPDATE custom_policy SET archived_at = now(), enabled = true WHERE id = $1`, [policyId]),
      '23514',
      'custom_policy_archived_check',
    );
  });
});

describe('decision with actor_type policy', () => {
  it('requires evaluation and revision, and forbids classifier/rule columns', async () => {
    const { revisionId } = await policy(t);
    const cid = await comment(t);
    const ev = await evaluation(t, cid, revisionId);
    const ins = (cols: string, vals: unknown[]) =>
      ctx.c.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason${cols})
         VALUES ($1, $2, $3, 'hide', 'enforce', 'policy', 'r'${vals.map((_, i) => `, $${i + 4}`).join('')})`,
        [t.organizationId, t.brandId, cid, ...vals],
      );
    await expectPgError(ins('', []), '23514', 'decision_actor_check');
    await expect(ins(', policy_evaluation_id, policy_revision_id', [ev, revisionId])).resolves.toBeTruthy();
    await expectPgError(
      ins(', policy_evaluation_id, policy_revision_id, rule_id', [ev, revisionId, t.ruleId]),
      '23514',
      'decision_actor_check',
    );
  });
  it('policy columns are only allowed on policy decisions', async () => {
    const { revisionId } = await policy(t);
    const cid = await comment(t);
    const ev = await evaluation(t, cid, revisionId);
    await expectPgError(
      ctx.c.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, actor_user_id, reason, policy_evaluation_id)
         VALUES ($1, $2, $3, 'flag', 'enforce', 'user', $4, 'r', $5)`,
        [t.organizationId, t.brandId, cid, t.userId, ev],
      ),
      '23514',
      'decision_policy_evidence_check',
    );
  });
  it('archiving a policy keeps its decisions', async () => {
    const { policyId, revisionId } = await policy(t);
    const cid = await comment(t);
    const ev = await evaluation(t, cid, revisionId);
    await ctx.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason, policy_evaluation_id, policy_revision_id)
       VALUES ($1, $2, $3, 'hide', 'enforce', 'policy', 'r', $4, $5)`,
      [t.organizationId, t.brandId, cid, ev, revisionId],
    );
    await ctx.c.query(`UPDATE custom_policy SET enabled = false, archived_at = now() WHERE id = $1`, [policyId]);
    const n = await ctx.c.query(`SELECT count(*)::int AS n FROM decision WHERE policy_revision_id = $1`, [revisionId]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('policy deletion', () => {
  it('refuses a hard delete of a policy that has decisions', async () => {
    const { policyId, revisionId } = await policy(t);
    const cid = await comment(t);
    const ev = await evaluation(t, cid, revisionId);
    await ctx.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason, policy_evaluation_id, policy_revision_id)
       VALUES ($1, $2, $3, 'hide', 'enforce', 'policy', 'r', $4, $5)`,
      [t.organizationId, t.brandId, cid, ev, revisionId],
    );
    await expectPgError(ctx.c.query(`DELETE FROM custom_policy WHERE id = $1`, [policyId]), '23503');
    const n = await ctx.c.query(`SELECT count(*)::int AS n FROM decision WHERE policy_revision_id = $1`, [revisionId]);
    expect(n.rows[0].n).toBe(1);
  });
  it('still lets a brand delete cascade through policies and their decisions', async () => {
    const x = await seedTenant(ctx.c, 'pol-del');
    const { revisionId } = await policy(x);
    const cid = await comment(x);
    const ev = await evaluation(x, cid, revisionId);
    await ctx.c.query(
      `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason, policy_evaluation_id, policy_revision_id)
       VALUES ($1, $2, $3, 'hide', 'enforce', 'policy', 'r', $4, $5)`,
      [x.organizationId, x.brandId, cid, ev, revisionId],
    );
    await ctx.c.query(`DELETE FROM brand WHERE id = $1`, [x.brandId]);
    const n = await ctx.c.query(`SELECT count(*)::int AS n FROM custom_policy WHERE brand_id = $1`, [x.brandId]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('policy_evaluation', () => {
  it('is unique per (comment, body, trigger) and its evidence is write-once', async () => {
    const { revisionId } = await policy(t);
    const cid = await comment(t);
    const ev = await evaluation(t, cid, revisionId);
    await expectPgError(evaluation(t, cid, revisionId), '23505', 'policy_evaluation_comment_id_body_sha256_trigger_key_key');
    await expectPgError(ctx.c.query(`UPDATE policy_evaluation SET outcome = 'flag' WHERE id = $1`, [ev]), '23001');
    await ctx.c.query(`UPDATE policy_evaluation SET fallback_at = now(), fallback_code = 'not_eligible' WHERE id = $1`, [ev]);
    await expectPgError(ctx.c.query(`UPDATE policy_evaluation SET fallback_code = 'other' WHERE id = $1`, [ev]), '23001');
  });
  it('rejects bad trigger keys and a failed row without a code', async () => {
    const cid = await comment(t);
    await expectPgError(
      ctx.c.query(
        `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key, status, failure_code)
         VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'rerun:x', 'failed', 'timeout')`,
        [t.organizationId, t.brandId, t.connectionId, cid],
      ),
      '23514',
      'policy_evaluation_trigger_key_check',
    );
    await expectPgError(
      ctx.c.query(
        `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key, status)
         VALUES ($1, $2, $3, $4, decode(repeat('ab', 32), 'hex'), 'ingest', 'failed')`,
        [t.organizationId, t.brandId, t.connectionId, cid],
      ),
      '23514',
      'policy_evaluation_status_check',
    );
  });
});

describe('actor types', () => {
  it('moderation_action and audit_event accept policy', async () => {
    const cid = await comment(t);
    await ctx.c.query(
      `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, request_key, status)
       VALUES ($1, $2, $3, $4, 'hide', 'policy', $5, 'pending')`,
      [t.organizationId, t.brandId, t.connectionId, cid, `pol:${uuid()}`],
    );
    await ctx.c.query(
      `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, details)
       VALUES ($1, $2, 'policy', 'comment.moderated', 'comment', $3, '{}'::jsonb)`,
      [t.organizationId, t.brandId, cid],
    );
  });
});

describe('policy_usage', () => {
  it('is unique per brand and period and never negative', async () => {
    const ins = (n: number) =>
      ctx.c.query(
        `INSERT INTO policy_usage (organization_id, brand_id, period_start, model_calls) VALUES ($1, $2, '2026-10-01', $3)`,
        [t.organizationId, t.brandId, n],
      );
    await expectPgError(ins(-1), '23514', 'policy_usage_model_calls_check');
    await ins(1);
    await expectPgError(ins(1), '23505', 'policy_usage_brand_id_period_start_key');
  });
});
