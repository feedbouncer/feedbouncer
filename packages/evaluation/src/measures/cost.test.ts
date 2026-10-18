import { describe, expect, it } from 'vitest';
import { costPer1000, MissingPriceError } from './cost.js';
import { item } from './fixtures.test-helper.js';
import { InputError } from '../io.js';
import type { Pricing, RunManifest } from '../schema.js';

const manifest = { bytesPerComment: null } as RunManifest;
const pricing = (over: Partial<Pricing> = {}): Pricing => ({
  pricedAt: '2026-10-01',
  currency: 'USD',
  models: { m: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  compute: { usdPerMonth: 0, commentsPerMonth: 1 },
  storage: { usdPerGbMonth: 0, retentionMonths: 0 },
  other: [],
  ...over,
});
const call = (over = {}) => ({
  stage: 'classifier' as const,
  model: 'm',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  retried: false,
  ...over,
});
const withCall = (c = call()) => item({ modelCalls: [c] });
const complete = (r: ReturnType<typeof costPer1000>) => {
  if (r.status !== 'complete' && r.status !== 'partial') throw new Error(r.status);
  return r;
};
const comp = (r: ReturnType<typeof costPer1000>, name: string) =>
  complete(r).components.find((c) => c.name === name)!;

describe('costPer1000', () => {
  it('prices two classifier calls at 0.14 USD per 1000', () => {
    const r = complete(costPer1000([withCall(), withCall()], manifest, pricing()));
    expect(comp(r, 'Classifier model').usdPer1000).toBeCloseTo(0.14, 6);
    expect(r.status).toBe('partial');
    expect(r.modelsSeen).toEqual(['m']);
  });

  it('prices cache reads at cacheReadPerMTok, falling back to input price', () => {
    const c = call({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 600 });
    const cheap = pricing({
      models: { m: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0.1 } },
    });
    expect(
      comp(costPer1000([withCall(c)], manifest, cheap), 'Classifier model').usdPer1000,
    ).toBeCloseTo(0.46, 6);
    const same = pricing({ models: { m: { inputPerMTok: 1, outputPerMTok: 1 } } });
    expect(
      comp(costPer1000([withCall(c)], manifest, same), 'Classifier model').usdPer1000,
    ).toBeCloseTo(1, 6);
  });

  it('counts rule-decided comments with no model call in n', () => {
    const r = complete(costPer1000([withCall(), item({ ruleDecided: true })], manifest, pricing()));
    expect(r.n).toBe(2);
    expect(comp(r, 'Classifier model').usdPer1000).toBeCloseTo(0.07, 6);
    expect(r.mix.shareRuleDecided).toBe(0.5);
    expect(r.mix.shareReachingClassifier).toBe(0.5);
    expect(r.mix.callsPerComment.classifier).toBe(0.5);
  });

  it('marks unknown usage calls partial and prices only known calls', () => {
    const r = complete(
      costPer1000([withCall(), withCall(call({ inputTokens: null }))], manifest, pricing()),
    );
    expect(r.unknownUsageCalls).toBe(1);
    expect(r.status).toBe('partial');
    expect(comp(r, 'Classifier model').usdPer1000).toBeCloseTo(0.07, 6);
  });

  it('prices a retried call at its final usage and counts it as unknown usage', () => {
    const fullBytes = { bytesPerComment: 100 } as RunManifest;
    const r = complete(costPer1000([withCall(call({ retried: true }))], fullBytes, pricing()));
    expect(r.unknownUsageCalls).toBe(1);
    expect(r.status).toBe('partial');
    expect(comp(r, 'Classifier model').usdPer1000).toBeCloseTo(0.14, 6);
  });

  it('treats calls with no recorded model as unknown usage without needing a price', () => {
    const timedOut = call({ model: 'unknown', inputTokens: null, outputTokens: null });
    const noModel = call({ model: 'unknown' });
    const r = complete(
      costPer1000([withCall(), withCall(timedOut), withCall(noModel)], manifest, pricing()),
    );
    expect(r.unknownUsageCalls).toBe(2);
    expect(r.modelsSeen).toEqual(['m']);
    expect(comp(r, 'Classifier model').usdPer1000).toBeCloseTo((0.07 / 3) * 2, 6);
  });

  it('is complete when all usage is known and storage is measured', () => {
    const r = costPer1000([withCall()], { bytesPerComment: 0 } as RunManifest, pricing());
    expect(r.status).toBe('complete');
  });

  it('throws MissingPriceError naming the model', () => {
    const run = () => costPer1000([withCall(call({ model: 'ghost-1' }))], manifest, pricing());
    expect(run).toThrow(MissingPriceError);
    expect(run).toThrow(/ghost-1/);
    expect(new MissingPriceError('x')).toBeInstanceOf(InputError);
  });

  it('prices compute, storage and other', () => {
    const p = pricing({
      compute: { usdPerMonth: 40, commentsPerMonth: 200000 },
      storage: { usdPerGbMonth: 0.12, retentionMonths: 12 },
      other: [{ name: 'Email', usdPer1000: 0.5 }],
    });
    const r = costPer1000([item()], { bytesPerComment: 2000 } as RunManifest, p);
    expect(comp(r, 'Compute').usdPer1000).toBeCloseTo(0.2, 6);
    expect(comp(r, 'Storage').usdPer1000).toBeCloseTo(0.00288, 6);
    expect(comp(r, 'Email').usdPer1000).toBe(0.5);
    expect(complete(r).totalUsdPer1000).toBeCloseTo(0.70288, 6);
    expect(complete(r).storageAssumption).toEqual({ bytesPerComment: 2000, retentionMonths: 12 });
  });

  it('storage is 0 with a note when bytesPerComment is unmeasured', () => {
    const c = comp(costPer1000([item()], manifest, pricing()), 'Storage');
    expect(c.usdPer1000).toBe(0);
    expect(c.note).toBe('not measured (no privilege)');
  });

  it('no items is not_enough_data', () => {
    expect(costPer1000([], manifest, pricing())).toEqual({ status: 'not_enough_data' });
  });

  it('no pricing reports the mix only', () => {
    const r = costPer1000(
      [item({ channel: 'poll', cohort: 'review', language: 'de' }), withCall()],
      manifest,
      null,
    );
    expect(r.status).toBe('no_pricing');
    if (r.status !== 'no_pricing') return;
    expect(r.mix.n).toBe(2);
    expect(r.mix.byChannel).toEqual({ poll: 1, webhook: 1 });
    expect(r.mix.byCohort).toEqual({ review: 1, automatic: 1 });
    expect(r.mix.byLanguage).toEqual({ de: 1, en: 1 });
  });
});
