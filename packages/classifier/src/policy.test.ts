import { describe, expect, it } from 'vitest';
import { resolvePolicy, ZERO_SCORES } from './defaults.js';
import { decide, roundScore, roundScores } from './policy.js';

const P = resolvePolicy([]);
const ok = { lowSignal: false, languageSupported: true };

describe('roundScore', () => {
  it('rounds to 4 decimals', () => {
    expect(roundScore(0.123456)).toBe(0.1235);
    expect(roundScore(0.80004)).toBe(0.8);
    expect(roundScore(1)).toBe(1);
    expect(roundScores({ ...ZERO_SCORES, spam: 0.66666 }).spam).toBe(0.6667);
  });
});

describe('decide', () => {
  it('nothing triggers on zero scores', () => {
    expect(decide(ZERO_SCORES, P, ok)).toEqual({
      outcome: null,
      primary: null,
      triggers: [],
      downgraded: null,
    });
  });
  it('score equal to the threshold triggers; below does not', () => {
    expect(decide({ ...ZERO_SCORES, spam: 0.8 }, P, ok).outcome).toBe('flag');
    expect(decide({ ...ZERO_SCORES, spam: 0.7999 }, P, ok).outcome).toBeNull();
    expect(decide(roundScores({ ...ZERO_SCORES, spam: 0.80004 }), P, ok).primary).toMatchObject({
      score: 0.8,
      threshold: 0.8,
    });
  });
  it('default severe categories hide', () => {
    expect(decide({ ...ZERO_SCORES, hate_speech: 0.9 }, P, ok).outcome).toBe('hide');
    expect(decide({ ...ZERO_SCORES, scam_phishing: 0.95 }, P, ok).outcome).toBe('hide');
  });
  it('most severe action wins and every trigger is recorded', () => {
    const policy = resolvePolicy([{ category: 'profanity', threshold: 0.5, action: 'remove' }]);
    const v = decide({ ...ZERO_SCORES, spam: 0.9, hate_speech: 0.85, profanity: 0.5 }, policy, ok);
    expect(v.outcome).toBe('remove');
    expect(v.primary?.category).toBe('profanity');
    expect(v.triggers.map((t) => t.category).sort()).toEqual(['hate_speech', 'profanity', 'spam']);
  });
  it('ties on action break on margin, then category priority', () => {
    const v = decide({ ...ZERO_SCORES, spam: 0.95, self_promotion: 0.85 }, P, ok);
    expect(v.primary?.category).toBe('spam');
    const t = decide({ ...ZERO_SCORES, spam: 0.9, self_promotion: 0.9 }, P, ok);
    expect(t.primary?.category).toBe('spam');
  });
  it('approve threshold yields approve, beaten by any flag', () => {
    const policy = resolvePolicy([
      { category: 'self_promotion', threshold: 0.3, action: 'approve' },
    ]);
    expect(decide({ ...ZERO_SCORES, self_promotion: 0.4 }, policy, ok).outcome).toBe('approve');
    expect(decide({ ...ZERO_SCORES, self_promotion: 0.4, spam: 0.9 }, policy, ok).outcome).toBe(
      'flag',
    );
  });
  it('threshold 0 triggers on every score including 0; threshold 1 only on 1', () => {
    const p0 = resolvePolicy([{ category: 'spam', threshold: 0, action: 'flag' }]);
    expect(decide(ZERO_SCORES, p0, ok).outcome).toBe('flag');
    const p1 = resolvePolicy([{ category: 'spam', threshold: 1, action: 'hide' }]);
    expect(decide({ ...ZERO_SCORES, spam: 0.9999 }, p1, ok).outcome).toBeNull();
    expect(decide({ ...ZERO_SCORES, spam: 1 }, p1, ok).outcome).toBe('hide');
  });
  it('low-signal input downgrades hide/remove to flag and says so', () => {
    const v = decide({ ...ZERO_SCORES, hate_speech: 0.99 }, P, {
      lowSignal: true,
      languageSupported: true,
    });
    expect(v.outcome).toBe('flag');
    expect(v.downgraded).toBe('low_signal');
    expect(v.primary).toMatchObject({ action: 'hide', effectiveAction: 'flag' });
  });
  it('unsupported language downgrades too; flag-only results are not marked downgraded', () => {
    expect(
      decide({ ...ZERO_SCORES, scam_phishing: 0.9 }, P, {
        lowSignal: false,
        languageSupported: false,
      }).downgraded,
    ).toBe('unsupported_language');
    expect(
      decide({ ...ZERO_SCORES, spam: 0.9 }, P, { lowSignal: true, languageSupported: true })
        .downgraded,
    ).toBeNull();
  });
  it('rounds raw scores before comparing and records the rounded score', () => {
    const v = decide({ ...ZERO_SCORES, spam: 0.79996 }, P, ok);
    expect(v.outcome).toBe('flag');
    expect(v.primary).toMatchObject({ score: 0.8, threshold: 0.8 });
  });
  it('non-finite scores never trigger', () => {
    const p0 = resolvePolicy([{ category: 'spam', threshold: 0, action: 'hide' }]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decide({ ...ZERO_SCORES, hate_speech: bad, spam: bad }, p0, ok)).toEqual({
        outcome: null,
        primary: null,
        triggers: [],
        downgraded: null,
      });
    }
  });
  it('low-signal input downgrades remove to flag', () => {
    const policy = resolvePolicy([{ category: 'spam', threshold: 0.5, action: 'remove' }]);
    const v = decide({ ...ZERO_SCORES, spam: 0.9 }, policy, {
      lowSignal: true,
      languageSupported: true,
    });
    expect(v).toMatchObject({ outcome: 'flag', downgraded: 'low_signal' });
    expect(v.primary).toMatchObject({ action: 'remove', effectiveAction: 'flag' });
  });
});
