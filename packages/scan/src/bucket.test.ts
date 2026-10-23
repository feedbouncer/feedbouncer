import { ZERO_SCORES } from '@feedbouncer/classifier';
import { expect, test } from 'vitest';
import { bucketOf, type ClassifyOutcome } from './bucket.js';

const input = { text: 'x', empty: false, lowSignal: false, truncated: false, inputChars: 1 };
const scored = (
  scores: Partial<Record<'spam' | 'scam_phishing', number>>,
  over: { lowSignal?: boolean; languageSupported?: boolean } = {},
): ClassifyOutcome => ({
  kind: 'scored',
  input: { ...input, lowSignal: over.lowSignal ?? false },
  scores: { ...ZERO_SCORES, ...scores },
  languageSupported: over.languageSupported ?? true,
});

test('scam thresholds', () => {
  expect(bucketOf(scored({ scam_phishing: 0.79 })).bucket).toBe('uncertain');
  expect(bucketOf(scored({ scam_phishing: 0.8 }))).toEqual({
    bucket: 'scam_spam',
    category: 'scam_phishing',
    score: 0.8,
  });
  expect(bucketOf(scored({ scam_phishing: 0.49 })).bucket).toBe('clean');
  expect(bucketOf(scored({ spam: 0.5 }))).toMatchObject({ bucket: 'uncertain', category: 'spam' });
});

test('ties go to the higher-priority category', () =>
  expect(bucketOf(scored({ spam: 0.9, scam_phishing: 0.9 })).category).toBe('scam_phishing'));

test('unclassified cases', () => {
  expect(bucketOf({ kind: 'unclassified' }).bucket).toBe('unclassified');
  expect(bucketOf(scored({ spam: 0.99 }, { lowSignal: true })).bucket).toBe('unclassified');
  expect(bucketOf(scored({ spam: 0.99 }, { languageSupported: false })).bucket).toBe(
    'unclassified',
  );
  const empty: ClassifyOutcome = {
    kind: 'scored',
    input: { ...input, empty: true },
    scores: ZERO_SCORES,
    languageSupported: true,
  };
  expect(bucketOf(empty).bucket).toBe('unclassified');
});
