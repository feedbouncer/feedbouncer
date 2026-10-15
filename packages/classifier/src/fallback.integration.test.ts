import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { DEFAULT_THRESHOLDS, ZERO_SCORES } from './defaults.js';
import { ClassifierActionFallback } from './fallback.js';
import { decide } from './policy.js';
import { prepareInput } from './prepare.js';
import { PgClassificationStore } from './store.js';
import type { CategoryScores, ThresholdPolicy } from './types.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgClassificationStore;
let fb: ClassifierActionFallback;
let A: Tenant;
let B: Tenant;
let n = 0;

const brandScope = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });
const connScope = (t: Tenant) => ({ ...brandScope(t), connectionId: t.connectionId });
const sha = (s: string) => createHash('sha256').update(s).digest();

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'fallback-test', onIdleError: () => {} });
  store = new PgClassificationStore(pool);
  fb = new ClassifierActionFallback({
    classifications: store,
    log: createLogger('fallback-test', 'error', () => {}),
  });
  A = await seedTenant(ctx.c, 'fba');
  B = await seedTenant(ctx.c, 'fbb');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

async function seedClassified(
  t: Tenant,
  scores: Partial<CategoryScores>,
  policy: ThresholdPolicy = DEFAULT_THRESHOLDS,
): Promise<{ id: string; commentId: string }> {
  const body = `fb body ${++n}`;
  const c = await ctx.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, platform_state,
       ingest_origin, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'visible', 'live', now()) RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, `ext-${randomUUID()}`, body],
  );
  const commentId = c.rows[0]!.id;
  const hash = sha(body);
  const ev = await ctx.c.query<{ id: string }>(
    `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key,
       ruleset_version, status) VALUES ($1, $2, $3, $4, $5, 'ingest', 'v1', 'no_match') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, commentId, hash],
  );
  const input = prepareInput(body);
  const full: CategoryScores = { ...ZERO_SCORES, ...scores };
  const row = await store.record(connScope(t), {
    commentId,
    sha: hash,
    triggerKey: 'ingest',
    status: 'classified',
    provider: 'openai',
    model: 'model-x',
    promptVersion: 'v1',
    scores: full,
    language: 'en',
    languageSupported: true,
    input,
    scoresReused: false,
    ruleEvaluationId: ev.rows[0]!.id,
    ruleDecided: false,
    policy,
    verdict: decide(full, policy, {
      lowSignal: input.lowSignal,
      languageSupported: true,
    }),
    reason: 'Classifier: matched policy',
  });
  return { id: row!.id, commentId };
}

const outcome = (t: Tenant, o: Record<string, unknown>) =>
  ({
    scope: connScope(t),
    platform: 'facebook',
    actionId: randomUUID(),
    commentId: randomUUID(),
    kind: 'hide',
    ruleId: null,
    code: null,
    ...o,
  }) as never;

const flags = async (commentId: string) =>
  (
    await ctx.c.query(
      `SELECT category, confidence::text, threshold::text, reason FROM decision
       WHERE comment_id = $1 AND outcome = 'flag' ORDER BY sequence`,
      [commentId],
    )
  ).rows;
const one = async (sql: string, v: unknown[]) => (await ctx.c.query(sql, v)).rows[0];

describe('ClassifierActionFallback', () => {
  it('ignores rule actors, foreign keys and noop', async () => {
    const { id, commentId } = await seedClassified(A, { hate_speech: 0.93 });
    await fb.onActionOutcome(
      outcome(A, { actorType: 'rule', requestKey: `rule-eval:${id}`, status: 'failed' }),
    );
    await fb.onActionOutcome(
      outcome(A, { actorType: 'classifier', requestKey: 'manual:1', status: 'failed' }),
    );
    await fb.onActionOutcome(
      outcome(A, { actorType: 'classifier', requestKey: `clf:${id}`, status: 'noop' }),
    );
    expect(await flags(commentId)).toHaveLength(0);
  });

  it('deferred (rate-limited) and failed produce one fallback flag decision (write-once)', async () => {
    const { id, commentId } = await seedClassified(A, { hate_speech: 0.93 });
    await fb.onActionOutcome(
      outcome(A, {
        actorType: 'classifier',
        requestKey: `clf:${id}`,
        status: 'deferred',
        code: 'rate_limited',
      }),
    );
    await fb.onActionOutcome(
      outcome(A, {
        actorType: 'classifier',
        requestKey: `clf:${id}`,
        status: 'failed',
        code: 'rate_limited',
      }),
    );
    expect(await flags(commentId)).toEqual([
      {
        category: 'hate_speech',
        confidence: '0.9300',
        threshold: '0.8000',
        reason: "Flagged for review: the classifier couldn't hide this comment (rate_limited).",
      },
    ]);
  });

  it('a failed classifier delete produces a fallback flag decision', async () => {
    const policy = {
      ...DEFAULT_THRESHOLDS,
      spam: { category: 'spam', threshold: 0.5, action: 'remove', source: 'brand' },
    } as unknown as ThresholdPolicy;
    const { id, commentId } = await seedClassified(A, { spam: 0.9 }, policy);
    await fb.onActionOutcome(
      outcome(A, {
        actorType: 'classifier',
        kind: 'delete',
        requestKey: `clf:${id}`,
        status: 'failed',
        code: 'permission_denied',
      }),
    );
    expect(await flags(commentId)).toMatchObject([
      { category: 'spam', confidence: '0.9000', threshold: '0.5000' },
    ]);
  });

  it('applied after a fallback sets recovered_at', async () => {
    const { id } = await seedClassified(A, { hate_speech: 0.93 });
    await fb.onActionOutcome(
      outcome(A, { actorType: 'classifier', requestKey: `clf:${id}`, status: 'failed', code: 'x' }),
    );
    await fb.onActionOutcome(
      outcome(A, { actorType: 'classifier', requestKey: `clf:${id}`, status: 'applied' }),
    );
    expect(
      (await one(`SELECT recovered_at FROM comment_classification WHERE id = $1`, [id]))
        .recovered_at,
    ).not.toBeNull();
  });

  it("an unhide key 'clf:<id>:unhide' that fails produces a fallback naming unhide", async () => {
    const { id, commentId } = await seedClassified(A, { hate_speech: 0.1 });
    expect(
      await store.recordReversal(brandScope(A), id, 'hate_speech', 0.1, 0.8, 'Unhidden: x'),
    ).toBe(true);
    await fb.onActionOutcome(
      outcome(A, {
        actorType: 'classifier',
        kind: 'unhide',
        requestKey: `clf:${id}:unhide`,
        status: 'failed',
        code: 'token_expired',
      }),
    );
    const f = await flags(commentId);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      category: 'hate_speech',
      confidence: '0.1000',
      threshold: '0.8000',
    });
    expect(f[0].reason).toContain("couldn't unhide");
  });

  it('a key whose classification belongs to another brand changes nothing', async () => {
    const { id, commentId } = await seedClassified(A, { hate_speech: 0.93 });
    await fb.onActionOutcome(
      outcome(B, { actorType: 'classifier', requestKey: `clf:${id}`, status: 'failed', code: 'x' }),
    );
    expect(await flags(commentId)).toHaveLength(0);
    expect(
      (await one(`SELECT fallback_at FROM comment_classification WHERE id = $1`, [id])).fallback_at,
    ).toBeNull();
  });
});
