import { describe, expect, it } from 'vitest';
import { createClassifierProvider, loadClassifierConfig } from './config.js';
import { DisabledProvider } from './provider.js';
import { LlmClassifierProvider } from './llm-provider.js';
import { MAX_CONFIGURABLE_WAIT_MS } from './jobs/specs.js';

describe('loadClassifierConfig', () => {
  it('defaults: disabled provider, 10s timeout, 7 languages, 2 in flight per brand, 30 min max wait', () => {
    const c = loadClassifierConfig({});
    expect(c).toMatchObject({
      model: null,
      timeoutMs: 10_000,
      perBrandInFlight: 2,
      maxWaitMs: 1_800_000,
    });
    expect(c.languages).toEqual(['en', 'es', 'pt', 'fr', 'de', 'it', 'nl']);
    expect(createClassifierProvider(c)).toBeInstanceOf(DisabledProvider);
  });
  it('builds an LLM provider whose id/model fit the decision columns', () => {
    const c = loadClassifierConfig({
      CLASSIFIER_PROVIDER: 'google',
      CLASSIFIER_MODEL: 'gemini-2.5-flash',
      CLASSIFIER_API_KEY: 'x'.repeat(40),
    });
    const p = createClassifierProvider(c);
    expect(p).toBeInstanceOf(LlmClassifierProvider);
    expect([p.id, p.model]).toEqual(['google', 'gemini-2.5-flash']);
  });
  it('validates languages and ranges', () => {
    expect(() => loadClassifierConfig({ CLASSIFIER_LANGUAGES: 'en,EN-us' })).toThrow();
    expect(() => loadClassifierConfig({ CLASSIFIER_TIMEOUT_MS: '30000' })).toThrow();
    expect(() => loadClassifierConfig({ CLASSIFIER_BRAND_MAX_IN_FLIGHT: '0' })).toThrow();
    expect(loadClassifierConfig({ CLASSIFIER_LANGUAGES: ' en , ja ' }).languages).toEqual([
      'en',
      'ja',
    ]);
  });
  it('caps the configurable max wait at the deferral budget', () => {
    expect(loadClassifierConfig({ CLASSIFIER_MAX_WAIT_MINUTES: '90' }).maxWaitMs).toBe(
      MAX_CONFIGURABLE_WAIT_MS,
    );
    expect(() => loadClassifierConfig({ CLASSIFIER_MAX_WAIT_MINUTES: '91' })).toThrow();
  });
});
