import { describe, expect, it } from 'vitest';
import { loadModelConfig } from './config.js';

const env = (o: Record<string, string>) => o;

describe('loadModelConfig', () => {
  it('returns null when the provider is unset or none', () => {
    expect(loadModelConfig(env({}), 'CLASSIFIER')).toBeNull();
    expect(loadModelConfig(env({ CLASSIFIER_PROVIDER: 'none' }), 'CLASSIFIER')).toBeNull();
  });
  it('reads anthropic with a key and no base URL', () => {
    const c = loadModelConfig(
      env({
        CLASSIFIER_PROVIDER: 'anthropic',
        CLASSIFIER_MODEL: 'claude-haiku-4-5',
        CLASSIFIER_API_KEY: 'k'.repeat(40),
      }),
      'CLASSIFIER',
    );
    expect(c).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', baseUrl: null });
    expect(JSON.stringify(c)).not.toContain('kkkk');
  });
  it('requires a model id that fits the decision column', () => {
    expect(() =>
      loadModelConfig(
        env({ CLASSIFIER_PROVIDER: 'openai', CLASSIFIER_API_KEY: 'k'.repeat(40) }),
        'CLASSIFIER',
      ),
    ).toThrow();
    expect(() =>
      loadModelConfig(
        env({
          CLASSIFIER_PROVIDER: 'openai',
          CLASSIFIER_MODEL: 'bad model!',
          CLASSIFIER_API_KEY: 'k'.repeat(40),
        }),
        'CLASSIFIER',
      ),
    ).toThrow();
  });
  it('rejects an unknown provider', () => {
    expect(() =>
      loadModelConfig(env({ CLASSIFIER_PROVIDER: 'acme', CLASSIFIER_MODEL: 'm' }), 'CLASSIFIER'),
    ).toThrow();
  });
  it('openai_compatible needs a base URL; key optional (local models)', () => {
    expect(() =>
      loadModelConfig(
        env({ CLASSIFIER_PROVIDER: 'openai_compatible', CLASSIFIER_MODEL: 'llama3.1:8b' }),
        'CLASSIFIER',
      ),
    ).toThrow();
    const c = loadModelConfig(
      env({
        CLASSIFIER_PROVIDER: 'openai_compatible',
        CLASSIFIER_MODEL: 'llama3.1:8b',
        CLASSIFIER_BASE_URL: 'http://localhost:11434/v1',
      }),
      'CLASSIFIER',
    );
    expect(c?.apiKey).toBeNull();
    expect(c?.baseUrl?.href).toBe('http://localhost:11434/v1');
  });
  it('hosted providers need an API key', () => {
    expect(() =>
      loadModelConfig(
        env({ CLASSIFIER_PROVIDER: 'google', CLASSIFIER_MODEL: 'gemini-2.5-flash' }),
        'CLASSIFIER',
      ),
    ).toThrow();
  });
  it('base URL: https anywhere; http only for loopback or with ALLOW_HTTP; never credentials, query or fragment', () => {
    const ok = { CLASSIFIER_PROVIDER: 'openai_compatible', CLASSIFIER_MODEL: 'm' };
    const load = (extra: Record<string, string>) =>
      loadModelConfig(env({ ...ok, ...extra }), 'CLASSIFIER');
    expect(() => load({ CLASSIFIER_BASE_URL: 'http://ollama:11434/v1' })).toThrow();
    expect(
      load({ CLASSIFIER_BASE_URL: 'http://ollama:11434/v1', CLASSIFIER_ALLOW_HTTP: 'true' }),
    ).not.toBeNull();
    expect(() => load({ CLASSIFIER_BASE_URL: 'https://u:p@llm.example.com/v1' })).toThrow();
    expect(() => load({ CLASSIFIER_BASE_URL: 'https://llm.example.com/v1?x=1' })).toThrow();
    expect(() => load({ CLASSIFIER_BASE_URL: 'file:///etc/passwd' })).toThrow();
  });
  it('error messages never contain the key or the rejected value', () => {
    expect.assertions(2);
    try {
      loadModelConfig(
        env({
          CLASSIFIER_PROVIDER: 'anthropic',
          CLASSIFIER_MODEL: 'bad model!',
          CLASSIFIER_API_KEY: 'sk-secret-value-1234567890',
        }),
        'CLASSIFIER',
      );
    } catch (e) {
      expect((e as Error).message).not.toContain('sk-secret');
      expect((e as Error).message).not.toContain('bad model!');
    }
  });
});
