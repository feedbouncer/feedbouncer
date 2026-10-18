import { InputError } from '../io.js';
import type { EvalItem, Pricing, RunManifest } from '../schema.js';

export type CommentMix = {
  n: number;
  byChannel: Record<string, number>;
  byCohort: Record<string, number>;
  shareRuleDecided: number;
  shareReachingClassifier: number;
  shareReachingPolicy: number;
  callsPerComment: { classifier: number; policy: number };
  byLanguage: Record<string, number>;
};

export type CostSection =
  | { status: 'not_enough_data' }
  | { status: 'no_pricing'; mix: CommentMix }
  | {
      status: 'complete' | 'partial';
      currency: 'USD';
      pricedAt: string;
      n: number;
      components: { name: string; usdPer1000: number; note?: string }[];
      totalUsdPer1000: number;
      unknownUsageCalls: number;
      modelsSeen: string[];
      mix: CommentMix;
      storageAssumption: { bytesPerComment: number | null; retentionMonths: number };
    };

/** A model used in the run has no entry in pricing.json. */
export class MissingPriceError extends InputError {
  constructor(model: string) {
    super('pricing.json', 'models', model, 'no price for a model used in the run');
    this.name = 'MissingPriceError';
  }
}

const DECIMALS = 1e6;
const round = (x: number) => Math.round(x * DECIMALS) / DECIMALS;

function tally(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function mixOf(items: readonly EvalItem[]): CommentMix {
  const n = items.length;
  const calls = (i: EvalItem, stage: 'classifier' | 'policy') =>
    i.modelCalls.filter((c) => c.stage === stage).length;
  const count = (f: (i: EvalItem) => boolean) => items.filter(f).length / n;
  const total = (stage: 'classifier' | 'policy') =>
    items.reduce((s, i) => s + calls(i, stage), 0) / n;
  return {
    n,
    byChannel: tally(items.map((i) => i.channel)),
    byCohort: tally(items.map((i) => i.cohort)),
    shareRuleDecided: count((i) => i.ruleDecided),
    shareReachingClassifier: count((i) => calls(i, 'classifier') > 0),
    shareReachingPolicy: count((i) => calls(i, 'policy') > 0),
    callsPerComment: { classifier: total('classifier'), policy: total('policy') },
    byLanguage: tally(items.map((i) => i.language)),
  };
}

export function costPer1000(
  items: readonly EvalItem[],
  manifest: RunManifest,
  pricing: Pricing | null,
): CostSection {
  const n = items.length;
  if (n === 0) return { status: 'not_enough_data' };
  const mix = mixOf(items);
  if (!pricing) return { status: 'no_pricing', mix };

  // Token count times USD per MTok is micro-dollars, so sums stay exact for decimal prices.
  const micro = { classifier: 0, policy: 0 };
  const models = new Set<string>();
  let unknownUsageCalls = 0;
  for (const it of items) {
    for (const c of it.modelCalls) {
      const price = pricing.models[c.model];
      if (!price) throw new MissingPriceError(c.model);
      models.add(c.model);
      if (c.inputTokens === null || c.outputTokens === null) {
        unknownUsageCalls += 1;
        continue;
      }
      const cached = Math.min(c.cacheReadTokens ?? 0, c.inputTokens);
      micro[c.stage] +=
        (c.inputTokens - cached) * price.inputPerMTok +
        cached * (price.cacheReadPerMTok ?? price.inputPerMTok) +
        c.outputTokens * price.outputPerMTok;
    }
  }

  const per1000 = (microTotal: number) => round((microTotal / 1e6 / n) * 1000);
  const { bytesPerComment } = manifest;
  const { retentionMonths, usdPerGbMonth } = pricing.storage;
  const storageUsd =
    bytesPerComment === null ? 0 : (bytesPerComment / 1e9) * usdPerGbMonth * retentionMonths;
  const components: { name: string; usdPer1000: number; note?: string }[] = [
    { name: 'Classifier model', usdPer1000: per1000(micro.classifier) },
    { name: 'Policy model', usdPer1000: per1000(micro.policy) },
    {
      name: 'Compute',
      usdPer1000: round((pricing.compute.usdPerMonth / pricing.compute.commentsPerMonth) * 1000),
      ...(pricing.compute.note ? { note: pricing.compute.note } : {}),
    },
    {
      name: 'Storage',
      usdPer1000: round(storageUsd * 1000),
      ...(bytesPerComment === null ? { note: 'not measured (no privilege)' } : {}),
    },
    ...pricing.other.map((o) => ({
      name: o.name,
      usdPer1000: round(o.usdPer1000),
      ...(o.note ? { note: o.note } : {}),
    })),
  ];

  return {
    status: unknownUsageCalls > 0 || bytesPerComment === null ? 'partial' : 'complete',
    currency: pricing.currency,
    pricedAt: pricing.pricedAt,
    n,
    components,
    totalUsdPer1000: round(components.reduce((s, c) => s + c.usdPer1000, 0)),
    unknownUsageCalls,
    modelsSeen: [...models].sort(),
    mix,
    storageAssumption: { bytesPerComment, retentionMonths },
  };
}
