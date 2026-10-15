import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgEvaluationStore, bodySha256 } from '@feedbouncer/rules';
import { evaluateRulesFor, scopeOf, seedCommentRow } from '@feedbouncer/classifier/testing';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgPolicyEvaluationStore, type EvaluationRecord } from './evaluations.js';
import { PgPolicyStore, type StoredPolicy } from './store.js';
import type { PolicyAction, PolicyMatch } from './types.js';

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgPolicyEvaluationStore;
let policies: PgPolicyStore;
let ruleEvals: PgEvaluationStore;
let t: Tenant;
let other: Tenant;
let a: { organizationId: string; brandId: string };
let conn: ConnectionScope;
let p1: StoredPolicy;
let p2: StoredPolicy;
let n = 0;

async function freshComment(tn: Tenant = t) {
  const body = `please DM my other account ${++n}`;
  const s = await seedCommentRow(db.c, tn, body);
  await evaluateRulesFor(ruleEvals, s, 'no_match');
  const r = await db.c.query<{ id: string }>(
    'SELECT id FROM rule_evaluation WHERE comment_id = $1',
    [s.id],
  );
  return {
    commentId: s.id,
    sha: Buffer.from(bodySha256(body), 'hex'),
    ruleEvaluationId: r.rows[0]!.id,
  };
}

const match = (
  p: StoredPolicy,
  confidence: 'high' | 'low',
  effectiveAction: PolicyAction = p.action,
): PolicyMatch => ({
  policyId: p.id,
  revisionId: p.revisionId,
  revision: p.revision,
  name: p.name,
  confidence,
  action: p.action,
  effectiveAction,
  downgrade: effectiveAction === p.action ? null : 'low_confidence',
});

function evaluated(
  c: { commentId: string; sha: Buffer; ruleEvaluationId: string },
  winner: PolicyMatch | null,
  matches: PolicyMatch[],
  triggerKey = 'ingest',
): EvaluationRecord {
  return {
    commentId: c.commentId,
    sha: c.sha,
    triggerKey,
    status: 'evaluated',
    ruleEvaluationId: c.ruleEvaluationId,
    provider: 'openai',
    model: 'gpt-x',
    promptVersion: 'pol-v1',
    checkedRevisionIds: [p1.revisionId, p2.revisionId],
    inputTruncated: false,
    lowSignal: false,
    decision: { outcome: winner?.effectiveAction ?? null, winner, matches },
    reason: 'Matched policy …',
  };
}

const decisionsFor = async (commentId: string) =>
  (
    await db.c.query(
      `SELECT actor_type, outcome, mode, policy_revision_id, policy_evaluation_id, reason
         FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [commentId],
    )
  ).rows;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'policies-evals-test', onIdleError: () => {} });
  store = new PgPolicyEvaluationStore(pool);
  policies = new PgPolicyStore(pool);
  ruleEvals = new PgEvaluationStore(pool);
  t = await seedTenant(db.c, 'evals');
  other = await seedTenant(db.c, 'evals-other');
  a = { organizationId: t.organizationId, brandId: t.brandId };
  conn = scopeOf(t);
  p1 = await withTransaction(pool, (c) =>
    policies.create(
      c,
      a,
      { name: 'Flag DMs', text: 'Flag comments asking people to DM', action: 'flag', vague: false },
      t.userId,
    ),
  );
  p2 = await withTransaction(pool, (c) =>
    policies.create(
      c,
      a,
      {
        name: 'Hide DMs',
        text: 'Hide comments telling people to DM another account',
        action: 'hide',
        vague: false,
      },
      t.userId,
    ),
  );
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

describe('PgPolicyEvaluationStore', () => {
  it('records an evaluated row with matches and one policy decision, idempotently', async () => {
    const c = await freshComment();
    const m1 = match(p1, 'high');
    const m2 = match(p2, 'high');
    const rec = evaluated(c, m2, [m1, m2]);
    const row = await store.record(conn, rec);
    expect(row).toMatchObject({
      status: 'evaluated',
      skipReason: null,
      failureCode: null,
      outcome: 'hide',
      winningRevisionId: p2.revisionId,
      fallbackAt: null,
    });
    expect(await store.record(conn, rec)).toBeNull(); // ON CONFLICT DO NOTHING
    expect(await store.find(a, c.commentId, c.sha, 'ingest')).toEqual(row);
    const d = await db.c.query(
      'SELECT actor_type, outcome, policy_revision_id, policy_evaluation_id, reason FROM decision WHERE comment_id = $1',
      [c.commentId],
    );
    expect(d.rows).toEqual([
      {
        actor_type: 'policy',
        outcome: 'hide',
        policy_revision_id: p2.revisionId,
        policy_evaluation_id: row!.id,
        reason: 'Matched policy …',
      },
    ]);
    const m = await db.c.query(
      'SELECT revision_id, confidence, effective_action FROM policy_evaluation_match WHERE evaluation_id = $1 ORDER BY revision_id',
      [row!.id],
    );
    expect(m.rows).toHaveLength(2);
    const e = await db.c.query(
      `SELECT provider, model, prompt_version, checked_revision_ids, input_truncated, low_signal, rule_evaluation_id
         FROM policy_evaluation WHERE id = $1`,
      [row!.id],
    );
    expect(e.rows[0]).toEqual({
      provider: 'openai',
      model: 'gpt-x',
      prompt_version: 'pol-v1',
      checked_revision_ids: [p1.revisionId, p2.revisionId],
      input_truncated: false,
      low_signal: false,
      rule_evaluation_id: c.ruleEvaluationId,
    });
  });

  it('an evaluated row with no match writes matches but no decision', async () => {
    const c = await freshComment();
    const row = await store.record(conn, evaluated(c, null, []));
    expect(row).toMatchObject({ status: 'evaluated', outcome: null, winningRevisionId: null });
    expect(await decisionsFor(c.commentId)).toEqual([]);
  });

  it('failed and skipped rows write no decision', async () => {
    const f = await freshComment();
    const failed = await store.record(conn, {
      commentId: f.commentId,
      sha: f.sha,
      triggerKey: 'ingest',
      status: 'failed',
      failureCode: 'unavailable',
      ruleEvaluationId: f.ruleEvaluationId,
      checkedRevisionIds: [p1.revisionId, p2.revisionId],
    });
    expect(failed).toMatchObject({
      status: 'failed',
      failureCode: 'unavailable',
      skipReason: null,
      outcome: null,
      winningRevisionId: null,
    });
    const fr = await db.c.query(
      'SELECT provider, model, checked_revision_ids FROM policy_evaluation WHERE id = $1',
      [failed!.id],
    );
    expect(fr.rows[0]).toEqual({
      provider: null,
      model: null,
      checked_revision_ids: [p1.revisionId, p2.revisionId],
    });
    expect(await decisionsFor(f.commentId)).toEqual([]);

    const s = await freshComment();
    const skipped = await store.record(conn, {
      commentId: s.commentId,
      sha: s.sha,
      triggerKey: 'ingest',
      status: 'skipped',
      skipReason: 'quota_exhausted',
      ruleEvaluationId: s.ruleEvaluationId,
    });
    expect(skipped).toMatchObject({
      status: 'skipped',
      skipReason: 'quota_exhausted',
      failureCode: null,
      outcome: null,
    });
    expect(await decisionsFor(s.commentId)).toEqual([]);

    const noRules = await store.record(conn, {
      commentId: s.commentId,
      sha: s.sha,
      triggerKey: `run:${randomUUID()}`,
      status: 'skipped',
      skipReason: 'rules_not_evaluated',
      ruleEvaluationId: null,
    });
    expect(noRules).toMatchObject({ status: 'skipped', skipReason: 'rules_not_evaluated' });
    expect(await decisionsFor(s.commentId)).toEqual([]);
  });

  it('a forged comment id from another brand writes nothing', async () => {
    const mine = await freshComment();
    const theirs = await seedCommentRow(db.c, other, 'their comment body');
    const m2 = match(p2, 'high');
    const rec = { ...evaluated(mine, m2, [m2]), commentId: theirs.id };
    expect(await store.record(conn, rec)).toBeNull();
    const n = await db.c.query(
      'SELECT count(*)::int AS n FROM policy_evaluation WHERE comment_id = $1',
      [theirs.id],
    );
    expect(n.rows[0].n).toBe(0);
    expect(await decisionsFor(theirs.id)).toEqual([]);
    // The other brand cannot read this brand's evaluations either.
    const row = await store.record(conn, evaluated(mine, m2, [m2]));
    const os = { organizationId: other.organizationId, brandId: other.brandId };
    expect(await store.find(os, mine.commentId, mine.sha, 'ingest')).toBeNull();
    expect(await store.latestForComment(os, mine.commentId)).toBeNull();
    expect(await store.recordFallback(os, row!.id, 'failed', 'reason')).toBe(false);
  });

  it('recordFallback is write-once and appends one flag decision; it skips the flag for deleted comments', async () => {
    const c = await freshComment();
    const m2 = match(p2, 'high');
    const row = (await store.record(conn, evaluated(c, m2, [m2])))!;
    expect(await store.recordFallback(a, row.id, 'not_eligible', 'reason')).toBe(true);
    expect(await store.recordFallback(a, row.id, 'failed', 'reason')).toBe(false);
    expect(await decisionsFor(c.commentId)).toEqual([
      expect.objectContaining({ actor_type: 'policy', outcome: 'hide', mode: 'enforce' }),
      {
        actor_type: 'policy',
        outcome: 'flag',
        mode: 'enforce',
        policy_revision_id: p2.revisionId,
        policy_evaluation_id: row.id,
        reason: 'reason',
      },
    ]);
    const f = await db.c.query(
      'SELECT fallback_code, fallback_at IS NOT NULL AS fell, recovered_at FROM policy_evaluation WHERE id = $1',
      [row.id],
    );
    expect(f.rows[0]).toEqual({ fallback_code: 'not_eligible', fell: true, recovered_at: null });
    expect((await store.find(a, c.commentId, c.sha, 'ingest'))!.fallbackAt).toBeInstanceOf(Date);

    await store.recordRecovered(a, row.id);
    await store.recordRecovered(a, row.id);
    const r = await db.c.query(
      'SELECT recovered_at IS NOT NULL AS recovered FROM policy_evaluation WHERE id = $1',
      [row.id],
    );
    expect(r.rows[0].recovered).toBe(true);

    // No winner: nothing to fall back from.
    const none = await freshComment();
    const nrow = (await store.record(conn, evaluated(none, null, [])))!;
    expect(await store.recordFallback(a, nrow.id, 'failed', 'reason')).toBe(false);

    await db.c.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c.commentId]);
    const again = (await store.record(conn, evaluated(c, m2, [m2], `run:${randomUUID()}`)))!;
    expect(await store.recordFallback(a, again.id, 'not_eligible', 'reason')).toBe(true);
    const ds = await decisionsFor(c.commentId);
    expect(ds.map((d) => d.outcome)).toEqual(['hide', 'flag', 'hide']);
  });

  it('latestForComment returns the newest evaluation with its matches', async () => {
    const c = await freshComment();
    expect(await store.latestForComment(a, c.commentId)).toBeNull();
    await store.record(conn, {
      commentId: c.commentId,
      sha: c.sha,
      triggerKey: 'ingest',
      status: 'failed',
      failureCode: 'timeout',
      ruleEvaluationId: c.ruleEvaluationId,
      checkedRevisionIds: [p1.revisionId],
    });
    const m1 = match(p1, 'low', 'flag');
    const m2 = match(p2, 'low', 'flag');
    const row = (await store.record(conn, evaluated(c, m1, [m1, m2], `run:${randomUUID()}`)))!;
    const view = await store.latestForComment(a, c.commentId);
    expect(view).toEqual({
      id: row.id,
      status: 'evaluated',
      skipReason: null,
      failureCode: null,
      outcome: 'flag',
      createdAt: expect.any(Date),
      checkedCount: 2,
      triggerKey: expect.stringMatching(/^run:/),
      matches: [
        {
          policyId: p1.id,
          name: 'Flag DMs',
          archived: false,
          revision: 1,
          text: p1.text,
          confidence: 'low',
          action: 'flag',
          effectiveAction: 'flag',
          downgrade: null,
        },
        {
          policyId: p2.id,
          name: 'Hide DMs',
          archived: false,
          revision: 1,
          text: p2.text,
          confidence: 'low',
          action: 'hide',
          effectiveAction: 'flag',
          downgrade: 'low_confidence',
        },
      ],
    });
  });

  it('a decision made by revision 1 still points at revision 1 after edits and archive', async () => {
    const p = await withTransaction(pool, (c) =>
      policies.create(
        c,
        a,
        { name: 'Old', text: 'Hide comments selling followers', action: 'hide', vague: false },
        t.userId,
      ),
    );
    const c = await freshComment();
    const m = match(p, 'high');
    const row = (await store.record(conn, evaluated(c, m, [m])))!;
    await withTransaction(pool, (x) =>
      policies.update(x, a, p.id, { text: 'Hide comments selling likes or followers' }, t.userId),
    );
    await withTransaction(pool, (x) =>
      policies.update(
        x,
        a,
        p.id,
        { text: 'Hide comments selling likes, views or followers', action: 'remove' },
        t.userId,
      ),
    );
    expect((await policies.revisions(a, p.id)).map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(await withTransaction(pool, (x) => policies.archive(x, a, p.id))).toBe(true);
    const d = await db.c.query(
      `SELECT r.revision, r.text, r.action, cp.name, cp.archived_at IS NOT NULL AS archived
         FROM decision d
         JOIN custom_policy_revision r ON r.brand_id = d.brand_id AND r.id = d.policy_revision_id
         JOIN custom_policy cp ON cp.brand_id = r.brand_id AND cp.id = r.policy_id
        WHERE d.comment_id = $1`,
      [c.commentId],
    );
    expect(d.rows).toEqual([
      {
        revision: 1,
        text: 'Hide comments selling followers',
        action: 'hide',
        name: 'Old',
        archived: true,
      },
    ]);
    const view = await store.latestForComment(a, c.commentId);
    expect(view?.id).toBe(row.id);
    expect(view?.matches).toEqual([
      expect.objectContaining({
        revision: 1,
        text: 'Hide comments selling followers',
        archived: true,
      }),
    ]);
    // A hard delete of the policy cannot take its decisions with it.
    await expect(db.c.query('DELETE FROM custom_policy WHERE id = $1', [p.id])).rejects.toThrow();
    expect(await decisionsFor(c.commentId)).toHaveLength(1);
  });
});
