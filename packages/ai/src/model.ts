// One adapter per vendor behind the AI SDK's LanguageModel; callers never import a vendor SDK.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelConfig } from './config.js';

export function createLanguageModel(c: ModelConfig): LanguageModel {
  const apiKey = c.apiKey?.reveal();
  const baseURL = c.baseUrl?.href.replace(/\/$/, '');
  const settings = { ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) };
  switch (c.provider) {
    case 'anthropic':
      return createAnthropic(settings)(c.model);
    case 'openai':
      return createOpenAI(settings)(c.model);
    case 'google':
      return createGoogle(settings)(c.model);
    case 'openai_compatible':
      if (!baseURL) throw new Error('openai_compatible requires a base URL');
      return createOpenAICompatible({ name: 'openai-compatible', baseURL, ...settings })(c.model);
  }
}
