import { describe, expect, it } from 'vitest';
import { ClassifierProviderError, DisabledProvider, rawClassificationSchema } from './provider.js';

const scores = {
  spam: 0.1,
  scam_phishing: 0,
  harassment_abuse: 0,
  hate_speech: 0,
  sexual_content: 0,
  profanity: 0,
  self_promotion: 0.5,
};

describe('rawClassificationSchema', () => {
  it('accepts exactly seven finite scores in [0,1] and a language code', () => {
    expect(rawClassificationSchema.parse({ scores, language: 'EN' })).toEqual({
      scores,
      language: 'en',
    });
    expect(rawClassificationSchema.parse({ scores, language: 'und' }).language).toBe('und');
  });
  it.each([
    ['score above 1', { scores: { ...scores, spam: 1.2 }, language: 'en' }],
    ['negative score', { scores: { ...scores, spam: -0.1 }, language: 'en' }],
    ['NaN', { scores: { ...scores, spam: Number.NaN }, language: 'en' }],
    ['missing category', { scores: { ...scores, spam: undefined }, language: 'en' }],
    ['extra category', { scores: { ...scores, sentiment: 0.2 }, language: 'en' }],
    ['string score', { scores: { ...scores, spam: '0.2' }, language: 'en' }],
    ['bad language', { scores, language: 'english<script>' }],
  ])('rejects %s (never clamps)', (_n, v) => {
    expect(rawClassificationSchema.safeParse(v).success).toBe(false);
  });
});

describe('DisabledProvider', () => {
  it('always fails with non-retryable disabled', async () => {
    const p = new DisabledProvider();
    expect([p.id, p.model]).toEqual(['none', 'none']);
    await expect(
      p.classify(
        { text: 'x', empty: false, lowSignal: true, truncated: false, inputChars: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'disabled', retryable: false });
  });
  it('error message never carries foreign text', () => {
    expect(new ClassifierProviderError('auth', false).message).toBe(
      'classifier provider error: auth',
    );
  });
});
