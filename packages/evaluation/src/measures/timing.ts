import type { EvalItem } from '../schema.js';
import { distribution, type Distribution } from '../stats.js';

const SEGMENTS = [
  'delivery',
  'ingestQueue',
  'processing',
  'hideQueue',
  'hideCall',
  'queueWait',
] as const;
type Segment = (typeof SEGMENTS)[number];

export type TimingSummary = {
  total: Distribution;
  breakdownN: number;
  segments: Record<Segment, Distribution>;
};

type Timed = EvalItem & { timing: NonNullable<EvalItem['timing']> };

function summarise(items: readonly Timed[]): TimingSummary {
  const withBreakdown = items.flatMap((i) => (i.timing.breakdown ? [i.timing.breakdown] : []));
  const pick: Record<Segment, (b: (typeof withBreakdown)[number]) => number> = {
    delivery: (b) => b.deliveryMs,
    ingestQueue: (b) => b.ingestQueueMs,
    processing: (b) => b.processingMs,
    hideQueue: (b) => b.hideQueueMs,
    hideCall: (b) => b.hideCallMs,
    queueWait: (b) => b.ingestQueueMs + b.hideQueueMs,
  };
  return {
    total: distribution(items.map((i) => i.timing.totalMs)),
    breakdownN: withBreakdown.length,
    segments: Object.fromEntries(
      SEGMENTS.map((s) => [s, distribution(withBreakdown.map(pick[s]))]),
    ) as Record<Segment, Distribution>,
  };
}

export function timeToHide(items: readonly EvalItem[], cohort: 'automatic') {
  const byChannel: Record<'webhook' | 'poll', Timed[]> = { webhook: [], poll: [] };
  let backfillExcluded = 0;
  let noopExcluded = 0;
  let timingInvalid = 0;
  let retried = 0;
  let negativeDelivery = 0;
  for (const i of items) {
    if (i.cohort !== cohort || i.outcome !== 'hidden') continue;
    if (i.channel === 'backfill') backfillExcluded++;
    else if (i.removalNoop) noopExcluded++;
    else if (!i.timing || i.timing.totalMs < 0) timingInvalid++;
    else {
      byChannel[i.channel].push(i as Timed);
      if (i.timing.retried) retried++;
      if (i.timing.breakdown && i.timing.breakdown.deliveryMs < 0) negativeDelivery++;
    }
  }
  return {
    byChannel: { webhook: summarise(byChannel.webhook), poll: summarise(byChannel.poll) },
    backfillExcluded,
    noopExcluded,
    timingInvalid,
    retried,
    negativeDelivery,
  };
}

export function reviewTimeToHide(items: readonly EvalItem[]) {
  const review = items.filter((i) => i.cohort === 'review');
  const suggestionsByStatus: Record<string, number> = {};
  const total: number[] = [];
  const wait: number[] = [];
  const without: number[] = [];
  for (const i of review) {
    if (i.review) {
      suggestionsByStatus[i.review.suggestionStatus] =
        (suggestionsByStatus[i.review.suggestionStatus] ?? 0) + 1;
    }
    if (i.outcome !== 'hidden' || !i.timing) continue;
    total.push(i.timing.totalMs);
    const h = i.review?.humanWaitMs;
    if (h != null) {
      wait.push(h);
      without.push(i.timing.totalMs - h);
    }
  }
  return {
    includingHumanWait: distribution(total),
    humanWait: distribution(wait),
    excludingHumanWait: distribution(without),
    suggestionsByStatus,
  };
}
