import { describe, expect, it } from 'vitest';
import { prepareInput } from '@feedbouncer/ai';
import { resolvePolicy, ZERO_SCORES } from './defaults.js';
import { decide, roundScores } from './policy.js';
import { scoreClassification } from './score.js';

const policy = resolvePolicy([]);
const input = prepareInput('buy cheap followers now at my page');

describe('scoreClassification', () => {
  it('rounds the scores', () => {
    const raw = { scores: { ...ZERO_SCORES, spam: 0.80004 }, language: 'en' };
    expect(scoreClassification(raw, input, policy, ['en']).scores).toEqual(roundScores(raw.scores));
  });
  it('an unsupported language is not supported, unless the input is empty', () => {
    const raw = { scores: ZERO_SCORES, language: 'ja' };
    expect(scoreClassification(raw, input, policy, ['en']).languageSupported).toBe(false);
    expect(scoreClassification(raw, prepareInput(''), policy, ['en']).languageSupported).toBe(true);
  });
  it('decides on the rounded scores with the input signals', () => {
    const raw = { scores: { ...ZERO_SCORES, spam: 0.8 }, language: 'ja' };
    const r = scoreClassification(raw, input, policy, ['en']);
    expect(r.verdict).toEqual(
      decide(roundScores(raw.scores), policy, {
        lowSignal: input.lowSignal,
        languageSupported: false,
      }),
    );
    expect(r.verdict.outcome).toBe('flag');
  });
});
