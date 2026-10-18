import type { Distribution, Rate } from '../stats.js';
import type { EvaluationReport } from './build.js';
import { escapeMd } from './escape.js';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const num = (x: number) => String(Math.round(x * 1000) / 1000);
const usd = (x: number) => `$${x.toFixed(4)}`;

function fmtRate(r: Rate): string {
  if (r.status === 'not_enough_data') return 'not enough data (n=0)';
  const base = `${pct(r.value)} (${r.k} of ${r.n}; 95% CI ${pct(r.ci95[0]).slice(0, -1)}–${pct(r.ci95[1])})`;
  return r.status === 'low_confidence' ? `${base} — low confidence (n<30)` : base;
}

function fmtDist(d: Distribution): string {
  if (d.status === 'not_enough_data') return 'not enough data (n=0)';
  const base = `p50 ${secs(d.p50)}, p95 ${secs(d.p95)}, max ${secs(d.max)} (n=${d.n})`;
  return d.status === 'low_confidence' ? `${base} — low confidence (n<30)` : base;
}

function fmtCount(d: Distribution): string {
  return d.status === 'not_enough_data'
    ? 'not enough data (n=0)'
    : `p50 ${d.p50}, p95 ${d.p95}, max ${d.max} (n=${d.n})`;
}

const breakdown = (title: string, rows: { key: string; rate: Rate }[]): string[] =>
  rows.length === 0
    ? []
    : [`${title}:`, '', ...rows.map((r) => `- ${escapeMd(r.key)}: ${fmtRate(r.rate)}`), ''];

const counts = (rec: Record<string, number>) =>
  Object.entries(rec)
    .map(([k, v]) => `${escapeMd(k)} ${v}`)
    .join(', ') || 'none';

function falseHideLines(f: EvaluationReport['automatic']['falseHides']): string[] {
  return [
    `False-hide rate: ${fmtRate(f.rate)}`,
    '',
    `Restored by a person: ${f.restored} (${f.restoredLabelledShouldHide} labelled should hide). Removals by delete: ${f.removalsByDelete}.`,
    '',
    ...breakdown('By decider', f.byDecider),
    ...breakdown('By category', f.byCategory),
    ...breakdown('By language', f.byLanguage),
  ];
}

function missedLines(m: EvaluationReport['automatic']['missed']): string[] {
  return [
    `Missed rate: ${fmtRate(m.rate)}`,
    '',
    `Hide attempts that failed: ${m.hideFailed}.`,
    '',
    ...breakdown('By category', m.byCategory),
    ...breakdown('By language', m.byLanguage),
  ];
}

function timingLines(t: EvaluationReport['automatic']['timeToHide']): string[] {
  const out: string[] = [];
  for (const ch of ['webhook', 'poll'] as const) {
    const s = t.byChannel[ch];
    out.push(`Channel ${ch}: total ${fmtDist(s.total)}`, '');
    if (s.breakdownN > 0) {
      out.push(
        `Breakdown (n=${s.breakdownN}):`,
        '',
        ...Object.entries(s.segments).map(([k, d]) => `- ${escapeMd(k)}: ${fmtDist(d)}`),
        '',
      );
    }
  }
  out.push(
    `Excluded: backfill ${t.backfillExcluded}, no-op removals ${t.noopExcluded}, invalid timing ${t.timingInvalid}. Retried: ${t.retried}. Negative delivery: ${t.negativeDelivery}.`,
    '',
  );
  return out;
}

function metaLines(m: NonNullable<EvaluationReport['meta']>): string[] {
  const c = m.config;
  return [
    `Observed on ${escapeMd(c.observedOn)}. Page: ${escapeMd(c.page)}. Profanity filter: ${escapeMd(c.profanityFilter)}.`,
    '',
    `Blocked keywords: ${c.blockedKeywords.length === 0 ? 'none' : c.blockedKeywords.map(escapeMd).join(', ')}.`,
    '',
    `Method: ${escapeMd(c.method)}`,
    '',
    ...(c.notCompared.length > 0
      ? ['Not compared:', '', ...c.notCompared.map((s) => `- ${escapeMd(s)}`), '']
      : []),
    `Compared ${m.compared}; not compared ${m.notCompared}; review cohort excluded ${m.reviewExcluded}.`,
    '',
    `Comments labelled should hide (n=${m.shouldHide.n}): both ${m.shouldHide.both}, FeedBouncer only ${m.shouldHide.feedbouncerOnly}, Meta only ${m.shouldHide.metaOnly}, neither ${m.shouldHide.neither}.`,
    '',
    `Comments labelled should stay (n=${m.shouldStay.n}): FeedBouncer false hides ${m.shouldStay.feedbouncerFalseHides}, Meta false hides ${m.shouldStay.metaFalseHides}.`,
    '',
    `Missed share, FeedBouncer: ${fmtRate(m.missedShare.feedbouncer)}`,
    '',
    `Missed share, Meta: ${fmtRate(m.missedShare.meta)}`,
    '',
  ];
}

function costLines(c: EvaluationReport['cost']): string[] {
  if (c.status === 'not_enough_data') return ['not enough data (n=0)', ''];
  const mix = c.mix;
  const mixLines = [
    `Comment mix (n=${mix.n}): channel ${counts(mix.byChannel)}; cohort ${counts(mix.byCohort)}.`,
    '',
    `Decided by rule: ${pct(mix.shareRuleDecided)}. Reaching the classifier: ${pct(mix.shareReachingClassifier)}. Reaching the policy model: ${pct(mix.shareReachingPolicy)}.`,
    '',
    `Model calls per comment: classifier ${num(mix.callsPerComment.classifier)}, policy ${num(mix.callsPerComment.policy)}.`,
    '',
  ];
  if (c.status === 'no_pricing')
    return ['No pricing file was supplied, so no cost is reported.', '', ...mixLines];
  return [
    `Total: ${usd(c.totalUsdPer1000)} per 1,000 comments (${c.status}). Priced on ${escapeMd(c.pricedAt)} in ${c.currency}.`,
    '',
    ...c.components.map(
      (x) => `- ${escapeMd(x.name)}: ${usd(x.usdPer1000)}${x.note ? ` (${escapeMd(x.note)})` : ''}`,
    ),
    '',
    `Models seen: ${c.modelsSeen.length === 0 ? 'none' : c.modelsSeen.map(escapeMd).join(', ')}. Calls with unknown usage: ${c.unknownUsageCalls}.`,
    '',
    `Storage assumption: ${c.storageAssumption.bytesPerComment === null ? 'bytes per comment not measured' : `${num(c.storageAssumption.bytesPerComment)} bytes per comment`}, kept ${num(c.storageAssumption.retentionMonths)} months.`,
    '',
    ...mixLines,
  ];
}

export function renderMarkdown(r: EvaluationReport): string {
  const d = r.dataset;
  const a = r.automatic;
  const v = r.review;
  const L: string[] = [];
  const reviewTitle = '### Review mode (human approval required)';

  L.push(
    '# FeedBouncer evaluation report',
    '',
    '## Summary',
    '',
    `Window: ${escapeMd(r.window.from)} to ${escapeMd(r.window.to)}.`,
    '',
    `- False-hide rate (automatic): ${fmtRate(a.falseHides.rate)}`,
    `- Missed rate (automatic): ${fmtRate(a.missed.rate)}`,
    `- Time to hide, webhook (automatic): ${fmtDist(a.timeToHide.byChannel.webhook.total)}`,
    `- Time to hide, poll (automatic): ${fmtDist(a.timeToHide.byChannel.poll.total)}`,
    r.cost.status === 'complete' || r.cost.status === 'partial'
      ? `- Cost per 1,000 comments: ${usd(r.cost.totalUsdPer1000)} (${r.cost.status})`
      : '- Cost per 1,000 comments: not reported',
    '',
    '## Dataset and labelling',
    '',
    `- Comments: ${d.items} (${counts(d.byCohort)})`,
    `- Labelled and settled: ${d.labelled}; unresolved: ${d.unresolved}`,
    `- Excluded, author deleted: ${d.excludedAuthorDeleted}; excluded, edited version not available: ${d.excludedEditedVersion}`,
    `- Labellers: ${d.labellerCount}; labels per comment: ${fmtCount(d.labelsPerItem)}`,
    `- Agreement between the first two labellers: ${fmtRate(d.agreement.percent)}; Cohen's kappa: ${d.agreement.kappa === null ? 'not available' : num(d.agreement.kappa)}`,
    '',
    `Settling rule: ${d.agreement.rule}`,
    '',
    '## False-hide rate',
    '',
    ...falseHideLines(a.falseHides),
    reviewTitle,
    '',
    ...falseHideLines(v.falseHides),
    '## Time to hide',
    '',
    ...timingLines(a.timeToHide),
    reviewTitle,
    '',
    'Review-mode time includes the wait for a human to approve.',
    '',
    `Including human wait: ${fmtDist(v.timeToHide.includingHumanWait)}`,
    '',
    `Human wait alone: ${fmtDist(v.timeToHide.humanWait)}`,
    '',
    `Excluding human wait: ${fmtDist(v.timeToHide.excludingHumanWait)}`,
    '',
    `Suggestions by status: ${counts(v.timeToHide.suggestionsByStatus)}`,
    '',
    '## Comments missed',
    '',
    ...missedLines(a.missed),
    reviewTitle,
    '',
    ...missedLines(v.missed),
    "## Comparison with Meta's built-in moderation",
    '',
    ...(r.meta ? metaLines(r.meta) : ['No Meta comparison was supplied.', '']),
    '## Cost per 1,000 comments',
    '',
    ...costLines(r.cost),
    '## Method and limits',
    '',
    `- Percentiles: ${r.method.percentile}`,
    `- Confidence intervals: ${r.method.ci}`,
    `- Low confidence below n=${r.method.lowConfidenceN}; language breakdowns merge groups below n=${r.method.languageMinN} into other`,
    `- Prompt versions: ${r.method.promptVersions.length === 0 ? 'none' : r.method.promptVersions.map(escapeMd).join(', ')}`,
    '',
    'Limits:',
    '',
    ...r.limits.map((s) => `- ${s}`),
    '',
    'Input files:',
    '',
    ...r.inputDigests.map((x) => `- ${escapeMd(x.file)}: ${x.sha256}`),
    '',
  );
  return L.join('\n');
}
