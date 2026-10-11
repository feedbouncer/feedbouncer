// Reads service configuration from environment variables. Error messages name
// the variable but NEVER include its value: URLs carry passwords.
export type Env = Readonly<Record<string, string | undefined>>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export const PG_PROTOCOLS = ['postgresql:', 'postgres:'] as const;
export const REDIS_PROTOCOLS = ['redis:', 'rediss:'] as const;

function present(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = present(env, name);
  if (value === undefined) {
    throw new EnvError(
      `${name} is not set. Copy .env.example to .env, or set it in the environment.`,
    );
  }
  return value;
}

export function readUrl(env: Env, name: string, protocols: readonly string[]): URL {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(
      `${name} is not a valid URL (value not shown because it may contain credentials).`,
    );
  }
  if (!protocols.includes(url.protocol)) {
    throw new EnvError(`${name} must use one of ${protocols.join(', ')}`);
  }
  return url;
}

export function readInt(
  env: Env,
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  const raw = present(env, name);
  if (raw === undefined) return opts.fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < opts.min || n > opts.max) {
    throw new EnvError(`${name} must be an integer between ${opts.min} and ${opts.max}`);
  }
  return n;
}

export function readEnum<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = present(env, name);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new EnvError(`${name} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

// For secrets (signing keys, API keys): required, with a minimum length. The
// error never contains the value.
export function readSecret(env: Env, name: string, opts: { minLength: number }): string {
  const value = required(env, name);
  if (value.length < opts.minLength) {
    throw new EnvError(`${name} must be at least ${opts.minLength} characters (value not shown).`);
  }
  return value;
}

export function readString(
  env: Env,
  name: string,
  opts: { fallback: string; maxLength: number; pattern?: RegExp },
): string {
  const value = present(env, name) ?? opts.fallback;
  if (value.length > opts.maxLength) {
    throw new EnvError(`${name} is not valid (at most ${opts.maxLength} characters).`);
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    throw new EnvError(`${name} is not valid (unexpected format).`);
  }
  return value;
}
