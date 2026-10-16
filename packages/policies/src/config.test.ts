import { describe, expect, it } from 'vitest';
import { createPolicyEvaluator, loadPolicyConfig, loadPolicyLimits } from './config.js';

const key = 'k'.repeat(40);
describe('loadPolicyConfig', () => {
  it('reuses the classifier model when POLICY_PROVIDER is unset', () => {
    const c = loadPolicyConfig({
      CLASSIFIER_PROVIDER: 'openai',
      CLASSIFIER_MODEL: 'gpt-x',
      CLASSIFIER_API_KEY: key,
    });
    expect(c.model).toMatchObject({ provider: 'openai', model: 'gpt-x' });
  });
  it('uses POLICY_* when set, and POLICY_PROVIDER=none disables', () => {
    expect(
      loadPolicyConfig({
        POLICY_PROVIDER: 'google',
        POLICY_MODEL: 'gemini-x',
        POLICY_API_KEY: key,
        CLASSIFIER_PROVIDER: 'openai',
        CLASSIFIER_MODEL: 'gpt-x',
        CLASSIFIER_API_KEY: key,
      }).model,
    ).toMatchObject({ provider: 'google' });
    const off = loadPolicyConfig({
      POLICY_PROVIDER: 'none',
      CLASSIFIER_PROVIDER: 'openai',
      CLASSIFIER_MODEL: 'gpt-x',
      CLASSIFIER_API_KEY: key,
    });
    expect(off.model).toBeNull();
    expect(createPolicyEvaluator(off).id).toBe('none');
  });
  it('defaults and ranges', () => {
    const c = loadPolicyConfig({});
    expect(c).toMatchObject({
      timeoutMs: 15_000,
      perBrandInFlight: 2,
      maxWaitMs: 60 * 60_000,
      monthlyCallsPerBrand: 20_000,
    });
    expect(() => loadPolicyConfig({ POLICY_TIMEOUT_MS: '100' })).toThrow();
    expect(() => loadPolicyConfig({ POLICY_MONTHLY_CALLS_PER_BRAND: '-1' })).toThrow();
  });
  it('limits for the API need no key', () => {
    expect(loadPolicyLimits({ POLICY_PROVIDER: 'openai' })).toEqual({
      monthlyCallsPerBrand: 20_000,
      evaluatorConfigured: true,
    });
    expect(loadPolicyLimits({})).toEqual({
      monthlyCallsPerBrand: 20_000,
      evaluatorConfigured: false,
    });
    expect(loadPolicyLimits({ CLASSIFIER_PROVIDER: 'google' }).evaluatorConfigured).toBe(true);
    expect(
      loadPolicyLimits({ POLICY_PROVIDER: 'none', CLASSIFIER_PROVIDER: 'openai' })
        .evaluatorConfigured,
    ).toBe(false);
  });
  it('rejects an unknown provider name instead of treating it as configured', () => {
    expect(() => loadPolicyLimits({ POLICY_PROVIDER: 'openia' })).toThrow();
  });
  it('never puts the key in an error message', () => {
    expect.assertions(1);
    try {
      loadPolicyConfig({
        POLICY_PROVIDER: 'openai',
        POLICY_MODEL: 'bad model!',
        POLICY_API_KEY: 'sk-secret-1234567890',
      });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('sk-secret');
    }
  });
});
