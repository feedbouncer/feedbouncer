// Deployment-level model selection. Keys come from env/_FILE only and stay inside a Secret.
import {
  EnvError,
  Secret,
  readEnum,
  readRequiredString,
  readSecret,
  readString,
  type Env,
} from '@feedbouncer/service-runtime';

export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'openai_compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
/** Same shape as decision_classifier_model_check. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ModelConfig {
  readonly provider: AiProvider;
  readonly model: string;
  readonly apiKey: Secret | null;
  readonly baseUrl: URL | null;
}

function parseBaseUrl(raw: string, name: string, allowHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EnvError(`${name} must be an absolute URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new EnvError(`${name} must use https`);
  }
  if (u.protocol === 'http:' && !allowHttp && !LOOPBACK.has(u.hostname)) {
    throw new EnvError(
      `${name} must use https unless the host is loopback or ${name.replace(/_BASE_URL$/, '_ALLOW_HTTP')}=true`,
    );
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new EnvError(`${name} must not contain credentials, a query or a fragment`);
  }
  return u;
}

export function loadModelConfig(env: Env, prefix: string): ModelConfig | null {
  const provider = readEnum(env, `${prefix}_PROVIDER`, [...AI_PROVIDERS, 'none'] as const, 'none');
  if (provider === 'none') return null;
  const model = readRequiredString(env, `${prefix}_MODEL`, { maxLength: 200, pattern: MODEL_ID });
  const rawUrl = readString(env, `${prefix}_BASE_URL`, { fallback: '', maxLength: 2048 });
  const allowHttp =
    readEnum(env, `${prefix}_ALLOW_HTTP`, ['true', 'false'] as const, 'false') === 'true';
  const baseUrl = rawUrl === '' ? null : parseBaseUrl(rawUrl, `${prefix}_BASE_URL`, allowHttp);
  if (provider === 'openai_compatible' && baseUrl === null) {
    throw new EnvError(`${prefix}_BASE_URL is required for openai_compatible`);
  }
  const hasKey = (env[`${prefix}_API_KEY`]?.trim() ?? '') !== '';
  if (provider !== 'openai_compatible' && !hasKey) {
    throw new EnvError(`${prefix}_API_KEY is required for ${provider}`);
  }
  const apiKey = hasKey ? new Secret(readSecret(env, `${prefix}_API_KEY`, { minLength: 8 })) : null;
  return { provider, model, apiKey, baseUrl };
}
