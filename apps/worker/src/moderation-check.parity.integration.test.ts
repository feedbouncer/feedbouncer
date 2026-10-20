// Parity: the connected-platform pipeline (rule_evaluate, comment_classify,
// policy_evaluate over stored comments) and checkText must give the same verdict
// for the same text and configuration. Both paths share the same fake classifier
// and policy evaluator, keyed by a marker in the text.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveOutcome, type ActionStep } from '@feedbouncer/actions';
import {
  PgClassificationStore,
  PgThresholdStore,
  ZERO_SCORES,
  classifyCommentJob,
  type CategoryScores,
  type ClassifierProvider,
  type RawClassification,
} from '@feedbouncer/classifier';
import { PgCommentStore, PgReviewModeReader } from '@feedbouncer/comments';
import { BrandSlots, createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { JobContext, JobDefinition } from '@feedbouncer/jobs';
import {
  checkText,
  toVerdict,
  type CheckDeps,
  type CheckResult,
} from '@feedbouncer/moderation-check';
import {
  PgPolicyEvaluationStore,
  PgPolicyStore,
  PgPolicyUsage,
  policyEvaluateJob,
  type PolicyEvaluator,
} from '@feedbouncer/policies';
import {
  ACTION_SEVERITY,
  PgEvaluationStore,
  PgRuleStore,
  RuleSetCache,
  bodySha256,
  ruleEvaluateJob,
  type RuleAction,
} from '@feedbouncer/rules';
import { fakeJobContext, seedCommentRow } from '@feedbouncer/rules/testing';
import { createLogger } from '@feedbouncer/service-runtime';

const quiet = createLogger('moderation-check-parity-test', 'error', () => {});
const LANGS = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl'];
const MAX_WAIT_MS = 30 * 60_000;
const ZERO_USAGE = { inputTokens: null, outputTokens: null, cacheReadTokens: null };

// Markers the fakes react to.
const SPAM = 'spammy';
const RUDE = 'rudeword';
const COMPETITOR = 'acmecorp';

type ClassifierInput = Parameters<ClassifierProvider['classify']>[0];
type PolicyInput = Parameters<PolicyEvaluator['evaluate']>[0];

const fakeClassifier: ClassifierProvider = {
  id: 'fake',
  model: 'fake-1',
  async classify(input: ClassifierInput): Promise<RawClassification> {
    const scores: CategoryScores = {
      ...ZERO_SCORES,
      ...(input.text.includes(SPAM) ? { spam: 0.9 } : {}),
      ...(input.text.includes(RUDE) ? { profanity: 0.7 } : {}),
    };
    return { scores, language: 'en' };
  },
};

const fakeEvaluator: PolicyEvaluator = {
  enabled: true,
  id: 'fake-policy',
  model: 'fake-policy-1',
  async evaluate(input: PolicyInput, policies) {
    const verdict = input.text.includes(COMPETITOR) ? 'clear_match' : 'no_match';
    return {
      verdicts: Object.fromEntries(policies.map((p) => [p.key, verdict])),
      usage: ZERO_USAGE,
    };
  },
};

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: ReturnType<typeof createPool>;
let slotPool: ReturnType<typeof createPool>;
let tenant: Tenant;
let comments: PgCommentStore;
let ruleEvaluations: PgEvaluationStore;
let ruleJob: JobDefinition<never>;
let classifyJob: JobDefinition<never>;
let policyJob: JobDefinition<never>;
let checkDeps: CheckDeps;

async function addRule(
  name: string,
  conditions: object,
  steps: ActionStep[],
  mode: 'enforce' | 'suggest',
  priority: number,
) {
  await db.c.query(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode, priority)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)`,
    [
      tenant.organizationId,
      tenant.brandId,
      name,
      JSON.stringify(conditions),
      deriveOutcome(steps),
      JSON.stringify(steps),
      mode,
      priority,
    ],
  );
}

async function setThreshold(category: string, threshold: number, action: RuleAction) {
  await db.c.query(
    `INSERT INTO classifier_threshold (organization_id, brand_id, category, threshold, action, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenant.organizationId, tenant.brandId, category, threshold, action, tenant.userId],
  );
}

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'parity-test', onIdleError: () => {} });
  slotPool = createPool(db.db.url, { applicationName: 'parity-slots', onIdleError: () => {} });
  comments = new PgCommentStore(pool);
  ruleEvaluations = new PgEvaluationStore(pool);
  const classifications = new PgClassificationStore(pool);
  const thresholds = new PgThresholdStore(pool);
  const policies = new PgPolicyStore(pool);
  const policyEvaluations = new PgPolicyEvaluationStore(pool);
  const usage = new PgPolicyUsage(pool);
  const cache = new RuleSetCache(new PgRuleStore(pool));
  const reviewMode = new PgReviewModeReader(pool, { now: () => Date.now() });
  const clock = { now: () => Date.now() };

  tenant = await seedTenant(db.c, 'parity');
  // Automation on (no review mode) and only the rules below.
  await db.c.query('UPDATE rule SET archived_at = now(), enabled = false WHERE brand_id = $1', [
    tenant.brandId,
  ]);
  await addRule(
    'scam',
    { type: 'keyword', terms: ['scam'] },
    [{ type: 'delete', confirmIrreversible: true }],
    'enforce',
    1,
  );
  await addRule('promo', { type: 'keyword', terms: ['promo'] }, [{ type: 'hide' }], 'suggest', 2);
  await addRule(
    'paypal links',
    {
      type: 'link_domain',
      mode: 'blocklist',
      domains: ['paypal.com'],
      exemptOwnDomains: true,
      shorteners: 'match',
      lookalikes: 'match',
    },
    [{ type: 'hide' }],
    'enforce',
    3,
  );
  await setThreshold('spam', 0.8, 'hide');
  await setThreshold('profanity', 0.6, 'flag');
  const brand = { organizationId: tenant.organizationId, brandId: tenant.brandId };
  await withTransaction(pool, async (c) => {
    const p = await policies.create(
      c,
      brand,
      { name: 'No competitor mentions', text: 'Mentions a competitor brand', action: 'hide' },
      tenant.userId,
    );
    await policies.update(c, brand, p.id, { enabled: true }, tenant.userId);
  });

  const noopActions = {
    request: async () => ({
      status: 'accepted' as const,
      action: { id: randomUUID(), status: 'pending', outcomeCode: null },
    }),
  };
  const slots = new BrandSlots(slotPool, 2, 'fb.parity');
  ruleJob = ruleEvaluateJob({
    comments,
    evaluations: ruleEvaluations,
    cache,
    runner: { start: async () => ({ id: randomUUID() }) as never },
    suggestions: { propose: async () => ({ skipped: 'duplicate' }) as never },
    reviewMode,
    log: quiet,
    clock,
  }) as unknown as JobDefinition<never>;
  classifyJob = classifyCommentJob({
    comments,
    ruleEvaluations,
    classifications,
    thresholds,
    provider: fakeClassifier,
    slots,
    actions: noopActions as never,
    suggestions: { propose: async () => ({ skipped: 'duplicate' }) as never },
    reviewMode,
    languages: LANGS,
    maxWaitMs: MAX_WAIT_MS,
    log: quiet,
    clock,
  }) as unknown as JobDefinition<never>;
  policyJob = policyEvaluateJob({
    comments,
    ruleEvaluations,
    policies,
    evaluations: policyEvaluations,
    usage,
    evaluator: fakeEvaluator,
    slots,
    actions: noopActions as never,
    suggestions: { propose: async () => ({ skipped: 'duplicate' }) as never },
    reviewMode,
    monthlyCallsPerBrand: 1_000,
    maxWaitMs: MAX_WAIT_MS,
    log: quiet,
    clock,
  }) as unknown as JobDefinition<never>;

  checkDeps = {
    rules: cache,
    thresholds,
    policies,
    classifier: fakeClassifier,
    policyEvaluator: fakeEvaluator,
    languages: LANGS,
    classifierTimeoutMs: 5_000,
    policyTimeoutMs: 5_000,
    policyBudget: { slots, usage, monthlyCallsPerBrand: 1_000 },
  };
});
afterAll(async () => {
  await pool.end();
  await slotPool.end();
  await db.close();
});

interface Connected {
  verdict: CheckResult['verdict'];
  decidedBy: CheckResult['decidedBy'];
}

/** Ingests `text` as a comment and runs the three real handlers in pipeline order. */
async function connected(text: string): Promise<Connected> {
  const c = await seedCommentRow(db.c, tenant, text);
  const ctx = (type: string): JobContext => fakeJobContext(tenant, 1, type, quiet);
  const base = { commentId: c.id, bodySha256: bodySha256(text), trigger: 'ingest' };
  const handle = (job: JobDefinition<never>, extra: object = {}) =>
    job.handle(ctx(job.type), { ...base, ...extra } as never);

  await handle(ruleJob);
  await handle(classifyJob, { requestedAt: Date.now() });
  await handle(policyJob, { requestedAt: Date.now() });

  const one = async (sql: string) =>
    (await db.c.query<{ status?: string; outcome: RuleAction | null }>(sql, [c.id])).rows[0];
  const rule = await one('SELECT status, outcome FROM rule_evaluation WHERE comment_id = $1');
  if (rule?.status === 'decided' && rule.outcome)
    return { verdict: toVerdict(rule.outcome), decidedBy: 'rule' };

  const clf = (await one('SELECT outcome FROM comment_classification WHERE comment_id = $1'))
    ?.outcome;
  const pol = (await one('SELECT outcome FROM policy_evaluation WHERE comment_id = $1'))?.outcome;
  const outcomes = [
    ['classifier', clf ?? null],
    ['policy', pol ?? null],
  ] as const;
  let best: { source: 'classifier' | 'policy'; action: RuleAction } | null = null;
  for (const [source, action] of outcomes) {
    // Strictly greater: on a tie the classifier, listed first, stays the source.
    if (action && (!best || ACTION_SEVERITY[action] > ACTION_SEVERITY[best.action]))
      best = { source, action };
  }
  return best
    ? { verdict: toVerdict(best.action), decidedBy: best.source }
    : { verdict: 'allow', decidedBy: 'none' };
}

// [name, text, the verdict both paths must give, the source that decides it]
const CASES: Array<[string, string, Connected]> = [
  ['rule enforce keyword', 'this is a scam', { verdict: 'block', decidedBy: 'rule' }],
  ['suggest-only rule', 'great promo today', { verdict: 'allow', decidedBy: 'none' }],
  ['spam score', `buy my ${SPAM} offers now`, { verdict: 'block', decidedBy: 'classifier' }],
  ['profanity score', `that is ${RUDE} nonsense`, { verdict: 'review', decidedBy: 'classifier' }],
  ['policy match', `try ${COMPETITOR} instead of this`, { verdict: 'block', decidedBy: 'policy' }],
  [
    'classifier flag and policy hide',
    `${RUDE} and ${COMPETITOR} are better`,
    { verdict: 'block', decidedBy: 'policy' },
  ],
  ['clean text', 'thanks for sharing, lovely photo', { verdict: 'allow', decidedBy: 'none' }],
  ['Cyrillic look-alike link', 'visit p\u0430ypal.com', { verdict: 'block', decidedBy: 'rule' }],
  ['zero-width joiner inside keyword', 'sc\u200Dam', { verdict: 'block', decidedBy: 'rule' }],
  ['emoji only', '\u{1F600}\u{1F44D}\u{1F525}', { verdict: 'allow', decidedBy: 'none' }],
];

describe('moderation check parity with the connected-platform pipeline', () => {
  it.each(CASES)(
    'gives the same verdict as the connected path: %s',
    async (_name, text, expectedOutcome) => {
      const expected = await connected(text);
      const actual = await checkText(
        checkDeps,
        { organizationId: tenant.organizationId, brandId: tenant.brandId },
        text,
        Date.now() + 30_000,
      );
      expect({ verdict: actual.verdict, decidedBy: actual.decidedBy }).toEqual(expected);
      // Guards against both paths agreeing on the wrong thing (e.g. a fake that never fires).
      expect(expected).toEqual(expectedOutcome);
      expect(actual.degraded).toBe(false);
    },
  );
});
