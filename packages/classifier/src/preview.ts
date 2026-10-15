import type { RuleAction } from '@feedbouncer/rules';
import { decide } from './policy.js';
import type { CategoryScores, ThresholdPolicy } from './types.js';

export interface PreviewRow {
  commentId: string;
  scores: CategoryScores;
  lowSignal: boolean;
  languageSupported: boolean;
}
export interface PreviewResult {
  examined: number;
  changed: number;
  transitions: Record<string, number>;
  samples: Array<{ commentId: string; before: RuleAction | null; after: RuleAction | null }>;
}
export const MAX_PREVIEW_SAMPLES = 20;

export function previewChange(
  rows: readonly PreviewRow[],
  current: ThresholdPolicy,
  proposed: ThresholdPolicy,
): PreviewResult {
  const out: PreviewResult = { examined: rows.length, changed: 0, transitions: {}, samples: [] };
  for (const r of rows) {
    const signals = { lowSignal: r.lowSignal, languageSupported: r.languageSupported };
    const before = decide(r.scores, current, signals).outcome;
    const after = decide(r.scores, proposed, signals).outcome;
    if (before === after) continue;
    out.changed += 1;
    const key = `${before ?? 'none'}→${after ?? 'none'}`;
    out.transitions[key] = (out.transitions[key] ?? 0) + 1;
    if (out.samples.length < MAX_PREVIEW_SAMPLES)
      out.samples.push({ commentId: r.commentId, before, after });
  }
  return out;
}
