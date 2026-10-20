import { describe, expect, it, vi } from 'vitest';
import { ProviderError, prepareInput, type PreparedInput } from '@feedbouncer/ai';
import {
  DisabledProvider,
  ZERO_SCORES,
  DEFAULT_THRESHOLDS,
  type CategoryScores,
  type ClassifierProvider,
  type RawClassification,
} from '@feedbouncer/classifier';
import {
  DisabledPolicyEvaluator,
  type ActivePolicy,
  type PolicyEvaluator,
} from '@feedbouncer/policies';
import {
  compileRuleSet,
  type BrandScope,
  type RuleAction,
  type RuleMode,
  type RuleRecord,
} from '@feedbouncer/rules';
import { checkText, type CheckDeps } from './check.js';

const scope: BrandScope = { organizationId: 'org', brandId: 'brand' };
const LANGS = ['en'];

const S = (o: Partial<CategoryScores> = {}): RawClassification => ({
  scores: { ...ZERO_SCORES, ...o },
  language: 'en',
});

class FakeProvider implements ClassifierProvider {
  readonly id = 'fake';
  readonly model = 'fake-1';
  calls = 0;
  inputs: PreparedInput[] = [];
  constructor(private readonly script: Array<RawClassification | ProviderError | 'hang'> = [S()]) {}
  async classify(input: PreparedInput, signal: AbortSignal): Promise<RawClassification> {
    this.inputs.push(input);
    const next = this.script[Math.min(this.calls++, this.script.length - 1)]!;
    if (next === 'hang') {
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    }
    if (next instanceof ProviderError) throw next;
    return next;
  }
}

const rule = (term: string, o: { action?: RuleAction; mode?: RuleMode } = {}): RuleRecord => ({
  id: 'rule-1',
  name: 'Banned words',
  conditions: { type: 'keyword', terms: [term], match: 'whole_word' },
  action: o.action ?? 'remove',
  actions: [],
  mode: o.mode ?? 'enforce',
  priority: 1,
  enabled: true,
  createdAt: new Date(0),
});

const active: ActivePolicy = {
  policyId: 'pol-1',
  revisionId: 'rev-1',
  revision: 2,
  name: 'No refunds talk',
  text: 'Comments asking for a refund',
  action: 'hide',
};
const evaluator = (verdict: 'clear_match' | 'no_match' = 'clear_match'): PolicyEvaluator => ({
  enabled: true,
  id: 'pe',
  model: 'pe-1',
  evaluate: vi.fn(async () => ({
    verdicts: { p1: verdict },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null },
  })),
});

function deps(o: Partial<CheckDeps> = {}, records: RuleRecord[] = []): CheckDeps {
  const set = compileRuleSet(records, { ownDomains: [] }, 'v1');
  return {
    rules: { get: async () => set },
    thresholds: { policy: async () => DEFAULT_THRESHOLDS },
    policies: { enabledForEvaluation: async () => [] },
    usage: { consume: vi.fn(async () => true) },
    classifier: new FakeProvider(),
    policyEvaluator: new DisabledPolicyEvaluator(),
    languages: LANGS,
    classifierTimeoutMs: 5000,
    policyTimeoutMs: 5000,
    policyMonthlyCallsPerBrand: 100,
    sleep: async () => {},
    ...o,
  };
}
const later = (ms = 20_000) => Date.now() + ms;

describe('checkText', () => {
  it('lets an enforcing rule decide without calling the classifier', async () => {
    const classifier = new FakeProvider();
    const r = await checkText(deps({ classifier }, [rule('scam')]), scope, 'total scam', later());
    expect(r).toMatchObject({ verdict: 'block', reasonCode: 'rule_matched', decidedBy: 'rule' });
    expect(classifier.calls).toBe(0);
  });

  it('does not let a suggest-mode rule decide', async () => {
    const classifier = new FakeProvider();
    const r = await checkText(
      deps({ classifier }, [rule('scam', { mode: 'suggest' })]),
      scope,
      'total scam',
      later(),
    );
    expect(classifier.calls).toBe(1);
    expect(r).toMatchObject({ verdict: 'allow', reasonCode: 'no_match' });
  });

  it('retries a retryable classifier error once', async () => {
    const failing = new FakeProvider([new ProviderError('timeout', true)]);
    const r = await checkText(deps({ classifier: failing }), scope, 'hello there', later());
    expect(failing.calls).toBe(2);
    expect(r).toMatchObject({
      verdict: 'review',
      reasonCode: 'classifier_unavailable',
      degraded: true,
    });

    const flaky = new FakeProvider([new ProviderError('timeout', true), S()]);
    const ok = await checkText(deps({ classifier: flaky }), scope, 'hello there', later());
    expect(flaky.calls).toBe(2);
    expect(ok).toMatchObject({ verdict: 'allow', degraded: false });
  });

  it('does not retry a non-retryable error', async () => {
    const classifier = new FakeProvider([new ProviderError('auth', false)]);
    const r = await checkText(deps({ classifier }), scope, 'hello there', later());
    expect(classifier.calls).toBe(1);
    expect(r.reason).toContain('(auth)');
  });

  it('answers before the deadline when the classifier hangs', async () => {
    const deadlineAt = Date.now() + 1500;
    const d = deps({ classifier: new FakeProvider(['hang']) });
    delete d.sleep;
    const r = await checkText(d, scope, 'hello there', deadlineAt);
    expect(Date.now()).toBeLessThan(deadlineAt);
    expect(r).toMatchObject({ reasonCode: 'classifier_unavailable', degraded: true });
    expect(r.reason).toContain('(timeout)');
  });

  it('degrades with a timeout when no time is left for a stage', async () => {
    const classifier = new FakeProvider();
    const r = await checkText(deps({ classifier }), scope, 'hello there', Date.now() + 500);
    expect(classifier.calls).toBe(0);
    expect(r.reason).toContain('(timeout)');
  });

  it('reports no classifier configured', async () => {
    const r = await checkText(
      deps({ classifier: new DisabledProvider() }),
      scope,
      'hello there',
      later(),
    );
    expect(r).toMatchObject({ reasonCode: 'classifier_not_configured', decidedBy: 'degraded' });
  });

  it('skips the policy stage when the evaluator is disabled', async () => {
    const d = deps({ policies: { enabledForEvaluation: async () => [active] } });
    const r = await checkText(d, scope, 'hello there', later());
    expect(d.usage.consume).not.toHaveBeenCalled();
    expect(r).toMatchObject({ verdict: 'allow', degraded: false });
  });

  it('skips the policy stage when there are no enabled policies', async () => {
    const d = deps({ policyEvaluator: evaluator() });
    await checkText(d, scope, 'hello there', later());
    expect(d.usage.consume).not.toHaveBeenCalled();
    expect(d.policyEvaluator.evaluate).not.toHaveBeenCalled();
  });

  it('runs an enabled policy and reports its match', async () => {
    const d = deps({
      policies: { enabledForEvaluation: async () => [active] },
      policyEvaluator: evaluator(),
    });
    const r = await checkText(d, scope, 'I want a refund', later());
    expect(d.usage.consume).toHaveBeenCalledWith(scope, 100);
    expect(r).toMatchObject({
      verdict: 'block',
      reasonCode: 'policy_matched',
      decidedBy: 'policy',
      evidence: { policyId: 'pol-1', policyRevision: 2 },
      models: { policy: { provider: 'pe', model: 'pe-1' } },
    });
  });

  it('degrades when the policy budget is used up', async () => {
    const d = deps({
      policies: { enabledForEvaluation: async () => [active] },
      policyEvaluator: evaluator(),
      usage: { consume: vi.fn(async () => false) },
    });
    const r = await checkText(d, scope, 'I want a refund', later());
    expect(d.policyEvaluator.evaluate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ verdict: 'review', reasonCode: 'policy_quota_exhausted' });
  });

  it('sends the whole text to the classifier without truncation', async () => {
    const classifier = new FakeProvider();
    const text = '😀'.repeat(2000);
    await checkText(deps({ classifier }), scope, text, later());
    expect(classifier.inputs[0]!.text).toBe(text);
  });

  it.each(['fr​ee mo‍ney', 'ｆｒｅｅ money'])('matches the evasion %j', async (text) => {
    const r = await checkText(deps({}, [rule('free money')]), scope, text, later());
    expect(r).toMatchObject({ verdict: 'block', decidedBy: 'rule' });
  });

  it('keeps the text out of every reason', async () => {
    const marker = 'zq9marker';
    const text = `buy now ${marker}`;
    const results = await Promise.all([
      checkText(deps({ classifier: new FakeProvider([S({ spam: 0.99 })]) }), scope, text, later()),
      checkText(
        deps({ classifier: new FakeProvider([new ProviderError('unavailable', false)]) }),
        scope,
        text,
        later(),
      ),
      checkText(
        deps({
          policies: { enabledForEvaluation: async () => [active] },
          policyEvaluator: evaluator(),
        }),
        scope,
        text,
        later(),
      ),
    ]);
    for (const r of results) expect(JSON.stringify(r)).not.toContain(marker);
  });

  it.each(['', '  ​', 'a'.repeat(4001)])('throws on unvalidated text %#', async (text) => {
    expect(prepareInput(text).empty || prepareInput(text).truncated).toBe(true);
    await expect(checkText(deps(), scope, text, later())).rejects.toThrow(RangeError);
  });
});
