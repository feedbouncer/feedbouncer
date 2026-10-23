import type { PreparedInput } from '@feedbouncer/ai';
import {
  CATEGORY_PRIORITY,
  DEFAULT_THRESHOLDS,
  type CategoryScores,
} from '@feedbouncer/classifier';
import type { ScanBucket, ScanCategory } from './contract.js';
import { UNCERTAIN_FLOOR } from './limits.js';

export type ClassifyOutcome =
  | { kind: 'unclassified' }
  | { kind: 'scored'; input: PreparedInput; scores: CategoryScores; languageSupported: boolean };

export function bucketOf(o: ClassifyOutcome): {
  bucket: ScanBucket;
  category: ScanCategory | null;
  score: number;
} {
  if (o.kind === 'unclassified' || o.input.empty || o.input.lowSignal || !o.languageSupported) {
    return { bucket: 'unclassified', category: null, score: 0 };
  }
  const { spam, scam_phishing: scam } = o.scores;
  const candidates: ScanCategory[] =
    spam === scam ? ['spam', 'scam_phishing'] : [scam > spam ? 'scam_phishing' : 'spam'];
  const category = candidates.sort(
    (x, y) => CATEGORY_PRIORITY.indexOf(x) - CATEGORY_PRIORITY.indexOf(y),
  )[0]!;
  const score = Math.max(spam, scam);
  if (score >= DEFAULT_THRESHOLDS[category].threshold)
    return { bucket: 'scam_spam', category, score };
  if (score >= UNCERTAIN_FLOOR) return { bucket: 'uncertain', category, score };
  return { bucket: 'clean', category, score };
}
