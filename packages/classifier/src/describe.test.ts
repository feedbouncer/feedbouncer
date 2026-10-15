import { describe, expect, it } from 'vitest';
import { resolvePolicy, ZERO_SCORES } from './defaults.js';
import { describeClassification, describeFallback, describeReversal } from './describe.js';
import { decide } from './policy.js';

const ok = { lowSignal: false, languageSupported: true };

describe('describeClassification', () => {
  it('names the winning category, score, threshold and action, then other triggers', () => {
    const v = decide({ ...ZERO_SCORES, hate_speech: 0.93, spam: 0.85 }, resolvePolicy([]), ok);
    expect(describeClassification(v, { truncated: false })).toBe(
      'Classifier: Hate speech 0.93 ≥ 0.80 → Hide. Also triggered: Spam 0.85 ≥ 0.80 (Flag for review).',
    );
  });
  it('explains downgrades and truncation', () => {
    const v = decide({ ...ZERO_SCORES, hate_speech: 0.93 }, resolvePolicy([]), {
      lowSignal: true,
      languageSupported: true,
    });
    const s = describeClassification(v, { truncated: true });
    expect(s).toContain('Hide downgraded to Flag for review: very short or emoji-only text.');
    expect(s).toContain('Only the first 4,000 characters were classified.');
  });
  it('is at most 2000 chars and contains no comment text', () => {
    const v = decide(
      {
        ...ZERO_SCORES,
        spam: 1,
        scam_phishing: 1,
        harassment_abuse: 1,
        hate_speech: 1,
        sexual_content: 1,
        profanity: 1,
        self_promotion: 1,
      },
      resolvePolicy([]),
      ok,
    );
    expect(describeClassification(v, { truncated: true }).length).toBeLessThanOrEqual(2000);
  });
});

describe('fallback / reversal text', () => {
  it('reads plainly', () => {
    expect(describeFallback('hide', 'unsupported')).toBe(
      "Flagged for review: the classifier couldn't hide this comment (unsupported).",
    );
    expect(describeReversal('harassment_abuse', 0.12, 0.8)).toBe(
      'Unhidden: Harassment or abuse now scores 0.12, below 0.80.',
    );
  });
});
