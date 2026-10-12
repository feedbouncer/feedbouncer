// Reads service configuration from environment variables. Error messages name
// the variable but NEVER include its value: URLs carry passwords.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

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

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** FB_ENV. Unset means production, so a deploy that forgets it gets the strict checks. */
export function readAppEnv(env: Env): AppEnv {
  return readEnum(env, 'FB_ENV', APP_ENVS, 'production');
}

export function readRequiredString(
  env: Env,
  name: string,
  opts: { maxLength: number; pattern: RegExp },
): string {
  const value = required(env, name);
  if (value.length > opts.maxLength || !opts.pattern.test(value)) {
    throw new EnvError(`${name} is not valid (unexpected format; value not shown).`);
  }
  return value;
}

export const MAX_SECRET_FILE_BYTES = 65_536;

export interface SecretFileSystem {
  /** Byte size of a regular file, or 'not-a-file'. Throws if the path cannot be stat'ed. */
  size(path: string): number | 'not-a-file';
  read(path: string): string;
}

// statSync follows symlinks on purpose: Docker and Kubernetes secret mounts are symlinks.
export const nodeSecretFileSystem: SecretFileSystem = {
  size: (p) => {
    const s = statSync(p);
    return s.isFile() ? s.size : 'not-a-file';
  },
  read: (p) => readFileSync(p, 'utf8'),
};

/**
 * For each listed NAME, NAME_FILE may point at a mounted secret file instead.
 * Returns a copy of env with NAME filled from the file and NAME_FILE removed.
 * The path is operator configuration (trusted), but it must be absolute, and
 * errors never include the file's content.
 */
export function resolveFileEnv(
  env: Env,
  names: readonly string[],
  fs: SecretFileSystem = nodeSecretFileSystem,
): Env {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of names) {
    const fileVar = `${name}_FILE`;
    const path = present(env, fileVar);
    if (path === undefined) continue;
    if (present(env, name) !== undefined) {
      throw new EnvError(`Set either ${name} or ${fileVar}, not both.`);
    }
    if (!isAbsolute(path) || path.includes('\0')) {
      throw new EnvError(`${fileVar} must be an absolute path.`);
    }
    let size: number | 'not-a-file';
    try {
      size = fs.size(path);
    } catch {
      throw new EnvError(`${fileVar} points to a file that does not exist or cannot be read.`);
    }
    if (size === 'not-a-file') throw new EnvError(`${fileVar} must point to a regular file.`);
    if (size > MAX_SECRET_FILE_BYTES) {
      throw new EnvError(`${fileVar} points to a file larger than ${MAX_SECRET_FILE_BYTES} bytes.`);
    }
    let content: string;
    try {
      content = fs.read(path);
    } catch {
      throw new EnvError(`${fileVar} points to a file that cannot be read.`);
    }
    const value = content.replace(/\r?\n$/, '');
    if (value.trim() === '') throw new EnvError(`${fileVar} points to an empty file.`);
    out[name] = value;
    delete out[fileVar];
  }
  return out;
}
