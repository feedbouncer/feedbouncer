import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgEvaluationStore, bodySha256 } from '@feedbouncer/rules';
import { evaluateRulesFor, scopeOf, seedCommentRow } from '@feedbouncer/classifier/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { decidePolicies } from './decide.js';
import { PgPolicyEvaluationStore } from './evaluations.js';
import { PolicyActionFallback } from './fallback.js';
import { PgPolicyStore } from './store.js';
import type { PolicyAction } from './types.js';

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let evaluations: PgPolicyEvaluationStore;
let policies: PgPolicyStore;
let ruleEvals: PgEvaluationStore;
let fb: PolicyActionFallback;
let A: Tenant;
let B: Tenant;
let n = 0;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'policy-fallback-test', onIdleError: () => {} });
  evaluations = new PgPolicyEvaluationStore(pool);
  policies = new PgPolicyStore(pool);
  ruleEvals = new PgEvaluationStore(pool);
  fb = new PolicyActionFallback({
    evaluations,
    log: createLogger('policy-fallback-test', 'error', () => {}),
  });
  A = await seedTenant(db.c, 'pfa');
  B = await seedTenant(db.c, 'pfb');
});
afterAll(async () => {
  await pool.end();
  await db.close();
});

const brandOf = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });

/** A comment a policy decided to `action`: evaluation, match and decision written by the store. */
async function seedEvaluated(t: Tenant, action: PolicyAction = 'hide') {
  const policy = await withTransaction(pool, (c) =>
    policies.create(
      c,
      brandOf(t),
      { name: `Fallback ${++n}`, text: 'Comments asking people to DM another account', action, vague: false },
      t.userId,
    ),
  );
  const body = `DM my other account ${++n}`;
  const s = await seedCommentRow(db.c, t, body);
  await evaluateRulesFor(ruleEvals, s, 'no_match');
  const rule = await db.c.query<{ id: string }>(
    'SELECT id FROM rule_evaluation WHERE comment_id = $1',
    [s.id],
  );
  const active = {
    policyId: policy.id,
    revisionId: policy.revisionId,
    revision: policy.revision,
    name: policy.name,
    text: policy.text,
    action: policy.action,
  };
  const decision = decidePolicies([active], new Map([[active.revisionId, 'clear_match']]), {
    lowSignal: false,
    moderatorActed: false,
  });
  const ev = await evaluations.record(scopeOf(t), {
    commentId: s.id,
    sha: Buffer.from(bodySha256(body), 'hex'),
    triggerKey: 'ingest',
    status: 'evaluated',
    ruleEvaluationId: rule.rows[0]!.id,
    provider: 'openai',
    model: 'gpt-test',
    promptVersion: 'pol-v1',
    checkedRevisionIds: [active.revisionId],
    inputTruncated: false,
    lowSignal: false,
    decision,
    reason: 'Matched policy',
  });
  return { ev: ev!, commentId: s.id };
}

const evt = (t: Tenant, o: Record<string, unknown>) =>
  ({
    scope: scopeOf(t),
    platform: 'facebook',
    actionId: randomUUID(),
    commentId: randomUUID(),
    kind: 'hide',
    actorType: 'policy',
    ruleId: null,
    requestKey: `pol:${randomUUID()}`,
    status: 'failed',
    code: null,
    ...o,
  }) as never;

async function decisionsFor(t: Tenant, commentId: string, actorType: string) {
  const r = await db.c.query<{ outcome: string; reason: string }>(
    `SELECT outcome, reason FROM decision
      WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3 AND actor_type = $4
      ORDER BY created_at, id`,
    [t.organizationId, t.brandId, commentId, actorType],
  );
  return r.rows;
}
async function evaluationRow(t: Tenant, id: string) {
  const r = await db.c.query<{
    fallback_at: Date | null;
    fallback_code: string | null;
    recovered_at: Date | null;
  }>(
    `SELECT fallback_at, fallback_code, recovered_at FROM policy_evaluation
      WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
    [t.organizationId, t.brandId, id],
  );
  return r.rows[0]!;
}

describe('PolicyActionFallback', () => {
  it('ignores non-policy actors, noop and foreign request keys', async () => {
    const { ev, commentId } = await seedEvaluated(A);
    const key = `pol:${ev.id}`;
    await fb.onActionOutcome(evt(A, { actorType: 'classifier', requestKey: key }));
    await fb.onActionOutcome(evt(A, { actorType: 'rule', requestKey: key }));
    await fb.onActionOutcome(evt(A, { actorType: 'user', requestKey: key }));
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'noop' }));
    await fb.onActionOutcome(evt(A, { requestKey: `clf:${ev.id}` }));
    await fb.onActionOutcome(evt(A, { requestKey: `pol:${ev.id}:unhide` }));
    await fb.onActionOutcome(evt(A, { requestKey: 'pol:not-a-uuid' }));
    // Another brand's outcome naming this evaluation changes nothing.
    await fb.onActionOutcome(evt(B, { requestKey: key }));
    expect((await decisionsFor(A, commentId, 'policy')).map((d) => d.outcome)).toEqual(['hide']);
    expect(await evaluationRow(A, ev.id)).toMatchObject({ fallback_at: null, recovered_at: null });
  });

  it('failed / not_eligible / deferred → recordFallback (flag decision once)', async () => {
    const { ev, commentId } = await seedEvaluated(A);
    const key = `pol:${ev.id}`;
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'failed', code: 'platform_error' }));
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'failed', code: 'platform_error' }));
    const d = await decisionsFor(A, commentId, 'policy');
    expect(d.map((x) => x.outcome)).toEqual(['hide', 'flag']);
    expect(d[1]!.reason).toBe(
      'A policy asked to hide this comment, but the platform did not allow it (platform_error). Flagged for review instead.',
    );
    expect(await evaluationRow(A, ev.id)).toMatchObject({ fallback_code: 'platform_error' });

    for (const status of ['not_eligible', 'deferred'] as const) {
      const s = await seedEvaluated(A, 'remove');
      await fb.onActionOutcome(
        evt(A, { kind: 'delete', requestKey: `pol:${s.ev.id}`, status, code: null }),
      );
      const ds = await decisionsFor(A, s.commentId, 'policy');
      expect(ds.map((x) => x.outcome)).toEqual(['remove', 'flag']);
      expect(ds[1]!.reason).toContain(`asked to delete this comment`);
      expect(ds[1]!.reason).toContain(`(${status})`);
    }
  });

  it('an unsafe outcome code is replaced by the status', async () => {
    const { ev } = await seedEvaluated(A);
    await fb.onActionOutcome(
      evt(A, { requestKey: `pol:${ev.id}`, status: 'failed', code: 'Bad <code>' }),
    );
    expect(await evaluationRow(A, ev.id)).toMatchObject({ fallback_code: 'failed' });
  });

  it('applied after a fallback → recordRecovered', async () => {
    const { ev } = await seedEvaluated(A);
    const key = `pol:${ev.id}`;
    // Applied with no fallback recorded changes nothing.
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'applied' }));
    expect((await evaluationRow(A, ev.id)).recovered_at).toBeNull();
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'failed', code: 'rate_limited' }));
    await fb.onActionOutcome(evt(A, { requestKey: key, status: 'applied' }));
    expect((await evaluationRow(A, ev.id)).recovered_at).not.toBeNull();
  });
});
