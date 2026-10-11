import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EnvError } from './env.js';
import {
  DEV_EXAMPLE_ENCRYPTION_KEY,
  PLACEHOLDER_VALUES,
  checkNotPlaceholder,
  isPlaceholder,
} from './placeholders.js';

const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
function exampleValue(name: string): string | undefined {
  return new RegExp(`^${name}=(.*)$`, 'm').exec(envExample)?.[1]?.trim();
}

describe('placeholder registry', () => {
  it('contains every secret value published in .env.example', () => {
    for (const name of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'AUTH_SECRET']) {
      expect(PLACEHOLDER_VALUES.has(exampleValue(name)!), name).toBe(true);
    }
    const keys = exampleValue('FB_ENCRYPTION_KEYS')!;
    for (const entry of keys.split(',')) {
      expect(PLACEHOLDER_VALUES.has(entry.slice(entry.indexOf(':') + 1))).toBe(true);
    }
    expect(keys).toContain(DEV_EXAMPLE_ENCRYPTION_KEY);
  });

  it('detects placeholder passwords inside connection URLs', () => {
    expect(isPlaceholder('postgresql://feedbouncer:dev-only-postgres-password@db:5432/x')).toBe(
      true,
    );
    expect(isPlaceholder('redis://:dev-only-redis-password@redis:6379/0')).toBe(true);
    expect(isPlaceholder('postgresql://u:a-real-password-9x@db:5432/x')).toBe(false);
    expect(isPlaceholder('not a url')).toBe(false);
  });
});

describe('checkNotPlaceholder', () => {
  const placeholder = 'dev-only-auth-secret-change-me-0123456789';

  it('throws in production, naming the setting but not the value', () => {
    try {
      checkNotPlaceholder('production', 'AUTH_SECRET', placeholder, () => {});
      throw new Error('expected EnvError');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as Error).message).toMatch(/AUTH_SECRET is set to a documented example value/);
      expect((err as Error).message).not.toContain(placeholder);
    }
  });

  it('warns (without the value) in development and test', () => {
    for (const appEnv of ['development', 'test'] as const) {
      const warnings: string[] = [];
      checkNotPlaceholder(appEnv, 'AUTH_SECRET', placeholder, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/AUTH_SECRET uses a documented example value/);
      expect(warnings[0]).not.toContain(placeholder);
    }
  });

  it('is silent for real values', () => {
    const warnings: string[] = [];
    checkNotPlaceholder('production', 'AUTH_SECRET', 'q8Zx-real-generated-secret-value-000', (m) =>
      warnings.push(m),
    );
    expect(warnings).toEqual([]);
  });
});
