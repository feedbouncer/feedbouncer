import { LANGUAGE_MIN_N, LOW_CONFIDENCE_N, REPORT_SCHEMA_VERSION } from '../constants.js';
import { resolveGroundTruth, type GroundTruth } from '../ground-truth.js';
import type { RunInputs } from '../io.js';
import { costPer1000, type CostSection } from '../measures/cost.js';
import { falseHides, missed } from '../measures/hides.js';
import { metaComparison } from '../measures/meta.js';
import { reviewTimeToHide, timeToHide } from '../measures/timing.js';
import type { MetaConfig, RunManifest } from '../schema.js';
import type { Distribution } from '../stats.js';

export type EvaluationReport = {
  reportSchemaVersion: typeof REPORT_SCHEMA_VERSION;
  inputDigests: RunInputs['inputDigests'];
  window: RunManifest['window'];
  dataset: {
    items: number;
    labelled: number;
    unresolved: number;
    excludedAuthorDeleted: number;
    excludedEditedVersion: number;
    byCohort: Record<string, number>;
    labelsPerItem: Distribution;
    labellerCount: number;
    agreement: GroundTruth['agreement'];
  };
  automatic: {
    falseHides: ReturnType<typeof falseHides>;
    missed: ReturnType<typeof missed>;
    timeToHide: ReturnType<typeof timeToHide>;
  };
  review: {
    falseHides: ReturnType<typeof falseHides>;
    missed: ReturnType<typeof missed>;
    timeToHide: ReturnType<typeof reviewTimeToHide>;
  };
  meta: (NonNullable<ReturnType<typeof metaComparison>> & { config: MetaConfig }) | null;
  cost: CostSection;
  method: {
    promptVersions: string[];
    percentile: 'nearest-rank';
    ci: 'Wilson 95%';
    lowConfidenceN: number;
    languageMinN: number;
  };
  limits: string[];
};

function limitsOf(
  inputs: RunInputs,
  timing: ReturnType<typeof timeToHide>,
  cost: CostSection,
  metaCompared: number | null,
): string[] {
  const limits: string[] = [];
  if (timing.backfillExcluded > 0)
    limits.push('time to hide excludes comments FeedBouncer saw only through backfill');
  if (cost.status === 'complete' || cost.status === 'partial') {
    if (cost.unknownUsageCalls > 0)
      limits.push(
        'token usage for timed-out model calls is not reported by providers, so model cost is a lower bound',
      );
  }
  if (metaCompared !== null)
    limits.push(`Meta comparison covers ${metaCompared} comments; see method`);
  limits.push('posted_at has 1-second resolution');
  const purged = inputs.manifest.timingUnavailableBeforeRetention;
  if (purged > 0)
    limits.push(
      `job ledger rows older than ${inputs.manifest.jobRetentionDays} days are purged; ${purged} hidden items have no breakdown`,
    );
  return limits;
}

export function buildReport(inputs: RunInputs): EvaluationReport {
  const { manifest, items } = inputs;
  const gt = resolveGroundTruth(inputs.labels, new Set(items.map((i) => i.item)));
  const byCohort: Record<string, number> = {};
  for (const i of items) byCohort[i.cohort] = (byCohort[i.cohort] ?? 0) + 1;

  const autoTiming = timeToHide(items, 'automatic');
  const cost = costPer1000(items, manifest, inputs.pricing);
  const metaRaw = inputs.metaConfig ? metaComparison(items, gt, inputs.meta) : null;
  const meta = metaRaw && inputs.metaConfig ? { ...metaRaw, config: inputs.metaConfig } : null;

  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    inputDigests: inputs.inputDigests,
    window: manifest.window,
    dataset: {
      items: items.length,
      labelled: gt.verdicts.size,
      unresolved: gt.unresolved,
      excludedAuthorDeleted: manifest.excludedAuthorDeleted,
      excludedEditedVersion: items.filter((i) => !i.judgedVersionAvailable).length,
      byCohort: Object.fromEntries(Object.entries(byCohort).sort(([a], [b]) => (a < b ? -1 : 1))),
      labelsPerItem: gt.labelsPerItem,
      labellerCount: gt.labellerCount,
      agreement: gt.agreement,
    },
    automatic: {
      falseHides: falseHides(items, gt, 'automatic'),
      missed: missed(items, gt, 'automatic'),
      timeToHide: autoTiming,
    },
    review: {
      falseHides: falseHides(items, gt, 'review'),
      missed: missed(items, gt, 'review'),
      timeToHide: reviewTimeToHide(items),
    },
    meta,
    cost,
    method: {
      promptVersions: [...manifest.promptVersions],
      percentile: 'nearest-rank',
      ci: 'Wilson 95%',
      lowConfidenceN: LOW_CONFIDENCE_N,
      languageMinN: LANGUAGE_MIN_N,
    },
    limits: limitsOf(inputs, autoTiming, cost, meta ? meta.compared : null),
  };
}
