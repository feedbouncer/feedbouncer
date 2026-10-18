import { describe, expect, it } from 'vitest';
import { EvalItem, LabelRow, MetaConfig, MetaRow, Pricing, RunManifest } from './schema.js';

const item = {
  item: 'i_0123456789abcdef',
  cohort: 'automatic',
  channel: 'webhook',
  platform: 'facebook',
  language: 'en',
  judgedVersionAvailable: true,
  ruleDecided: false,
  outcome: 'hidden',
  removalKind: 'hide',
  removalNoop: false,
  restored: false,
  selfReversed: false,
  decider: 'classifier:spam',
  caughtByDecision: true,
  review: null,
  timing: {
    totalMs: 10,
    retried: false,
    breakdown: { deliveryMs: 1, ingestQueueMs: 2, processingMs: 3, hideQueueMs: 2, hideCallMs: 2 },
  },
  modelCalls: [
    { stage: 'classifier', model: 'p:m', inputTokens: 1, outputTokens: 2, cacheReadTokens: null },
  ],
};

const meta = {
  observedOn: '2026-10-01',
  page: 'Test page',
  profanityFilter: 'off',
  blockedKeywords: [],
  method: 'm',
  notCompared: [],
};

const pricing = {
  pricedAt: '2026-10-01',
  currency: 'USD',
  models: { 'p:m': { inputPerMTok: 1, outputPerMTok: 2 } },
  compute: { usdPerMonth: 10, commentsPerMonth: 1000 },
  storage: { usdPerGbMonth: 0.1, retentionMonths: 3 },
  other: [],
};

describe('schemas', () => {
  it('accepts a valid EvalItem', () => {
    expect(EvalItem.parse(item)).toEqual(item);
  });
  it('EvalItem rejects unknown keys', () => {
    expect(() => EvalItem.parse({ ...item, text: 'hello' })).toThrow();
    expect(() => EvalItem.parse({ ...item, author: 'x' })).toThrow();
    expect(() => EvalItem.parse({ ...item, id: 'x' })).toThrow();
  });
  it('EvalItem validates id, language and decider shapes', () => {
    expect(() => EvalItem.parse({ ...item, item: 'bad' })).toThrow();
    expect(() => EvalItem.parse({ ...item, language: 'EN' })).toThrow();
    expect(EvalItem.parse({ ...item, language: 'und' }).language).toBe('und');
    expect(() => EvalItem.parse({ ...item, decider: 'rule:Bad' })).toThrow();
    expect(EvalItem.parse({ ...item, decider: 'suggestion:policy' }).decider).toBe(
      'suggestion:policy',
    );
  });
  it('RunManifest and LabelRow ignore nothing unexpected', () => {
    const manifest = {
      runSchemaVersion: 1,
      exportedAt: '2026-10-18T00:00:00Z',
      window: { from: 'a', to: 'b' },
      brandsScoped: false,
      itemCount: 1,
      labelSheetCount: 1,
      sample: null,
      excludedAuthorDeleted: 0,
      timingUnavailableBeforeRetention: 0,
      bytesPerComment: null,
      promptVersions: [],
      jobRetentionDays: 30,
    };
    expect(RunManifest.parse(manifest)).toEqual(manifest);
    expect(() => RunManifest.parse({ ...manifest, runSchemaVersion: 2 })).toThrow();
  });
  it('LabelRow ignores extra CSV columns and checks labeller', () => {
    const row = LabelRow.parse({
      item: 'i_0123456789abcdef',
      labeller: 'anna',
      verdict: 'should_hide',
      text: 'ignored',
    });
    expect(row).toEqual({ item: 'i_0123456789abcdef', labeller: 'anna', verdict: 'should_hide' });
    expect(() =>
      LabelRow.parse({ item: 'i_0123456789abcdef', labeller: 'a b', verdict: 'should_hide' }),
    ).toThrow();
  });
  it('MetaRow caps note length', () => {
    expect(() =>
      MetaRow.parse({ item: 'i_0123456789abcdef', meta_outcome: 'hidden', note: 'x'.repeat(201) }),
    ).toThrow();
  });
  it('MetaConfig rejects page containing "http"', () => {
    expect(MetaConfig.parse(meta).page).toBe('Test page');
    expect(() => MetaConfig.parse({ ...meta, page: 'see https://x.example' })).toThrow();
  });
  it('Pricing rejects negative price', () => {
    expect(Pricing.parse(pricing).currency).toBe('USD');
    expect(() =>
      Pricing.parse({ ...pricing, models: { 'p:m': { inputPerMTok: -1, outputPerMTok: 2 } } }),
    ).toThrow();
    expect(() =>
      Pricing.parse({ ...pricing, compute: { usdPerMonth: 1, commentsPerMonth: 0 } }),
    ).toThrow();
  });
});
