import { Secret } from '@feedbouncer/service-runtime';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface McpConfig {
  apiBaseUrl: URL;
  apiKey: Secret;
  requestTimeoutMs: number;
  replyWaitMs: number;
}

// Matches the local API published by compose.yaml.
const DEFAULT_API_URL = 'http://127.0.0.1:3001';

/** The environment the server reads; the docs and tools.json are generated from this. */
export const MCP_ENV_DOCS: readonly {
  name: 'FEEDBOUNCER_API_KEY' | 'FEEDBOUNCER_API_URL';
  required: boolean;
  default?: string;
  rule: string;
}[] = [
  {
    name: 'FEEDBOUNCER_API_KEY',
    required: true,
    rule: 'A FeedBouncer API key: fbk_<16 characters>_<43 characters>.',
  },
  {
    name: 'FEEDBOUNCER_API_URL',
    required: false,
    default: DEFAULT_API_URL,
    rule: 'Base URL of the FeedBouncer API; blank uses the default. Must use https, except on localhost, 127.0.0.1 or [::1]; no credentials, query string or fragment.',
  },
];
const API_KEY = /^fbk_[a-z2-7]{16}_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseApiUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('FEEDBOUNCER_API_URL is not a valid URL');
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    throw new ConfigError(
      'FEEDBOUNCER_API_URL must use https (http is only allowed for localhost)',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(
      'FEEDBOUNCER_API_URL must not contain credentials, a query string or a fragment',
    );
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv): McpConfig {
  const key = env.FEEDBOUNCER_API_KEY;
  if (key === undefined || !API_KEY.test(key)) {
    throw new ConfigError('FEEDBOUNCER_API_KEY is missing or malformed');
  }
  return {
    apiBaseUrl: parseApiUrl(env.FEEDBOUNCER_API_URL?.trim() || DEFAULT_API_URL),
    apiKey: new Secret(key),
    requestTimeoutMs: 10_000,
    replyWaitMs: 15_000,
  };
}
