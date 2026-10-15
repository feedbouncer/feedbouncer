import { describe, expect, it } from 'vitest';
import { createLanguageModel } from './model.js';

describe('createLanguageModel', () => {
  it.each(['anthropic', 'openai', 'google', 'openai_compatible'] as const)(
    'builds a model for %s without network I/O',
    (provider) => {
      const m = createLanguageModel({
        provider,
        model: 'test-model',
        apiKey: null,
        baseUrl: provider === 'openai_compatible' ? new URL('http://localhost:11434/v1') : null,
      });
      expect(m).toBeTruthy();
      expect(typeof m === 'object' && 'modelId' in m ? m.modelId : 'test-model').toBe('test-model');
    },
  );
});
