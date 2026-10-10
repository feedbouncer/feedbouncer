import { describe, expect, it } from 'vitest';
import { EnvError, PG_PROTOCOLS, REDIS_PROTOCOLS, readEnum, readInt, readUrl } from './env.js';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return (err as Error).message;
  }
  throw new Error('expected an EnvError');
}

describe('readUrl', () => {
  it('parses a valid URL', () => {
    const url = readUrl(
      { DATABASE_URL: 'postgresql://u:p@postgres:5432/db' },
      'DATABASE_URL',
      PG_PROTOCOLS,
    );
    expect(url.hostname).toBe('postgres');
  });

  it('names the missing variable and points at .env.example', () => {
    expect(messageOf(() => readUrl({}, 'DATABASE_URL', PG_PROTOCOLS))).toMatch(
      /DATABASE_URL is not set.*\.env\.example/,
    );
  });

  it('treats a blank value as missing', () => {
    expect(messageOf(() => readUrl({ DATABASE_URL: '   ' }, 'DATABASE_URL', PG_PROTOCOLS))).toMatch(
      /is not set/,
    );
  });

  it('never echoes a malformed value (it may contain a password)', () => {
    const msg = messageOf(() =>
      readUrl({ DATABASE_URL: 'pg hunter2 @@' }, 'DATABASE_URL', PG_PROTOCOLS),
    );
    expect(msg).toMatch(/DATABASE_URL is not a valid URL/);
    expect(msg).not.toContain('hunter2');
  });

  it('rejects a disallowed protocol without echoing credentials', () => {
    const msg = messageOf(() =>
      readUrl({ REDIS_URL: 'http://:hunter2@redis:6379' }, 'REDIS_URL', REDIS_PROTOCOLS),
    );
    expect(msg).toMatch(/REDIS_URL must use one of redis:, rediss:/);
    expect(msg).not.toContain('hunter2');
  });
});

describe('readInt', () => {
  const opts = { min: 1, max: 64, fallback: 4 };
  it('falls back when unset or blank', () => {
    expect(readInt({}, 'N', opts)).toBe(4);
    expect(readInt({ N: '' }, 'N', opts)).toBe(4);
  });
  it('accepts an in-range integer', () => {
    expect(readInt({ N: '8' }, 'N', opts)).toBe(8);
  });
  it.each(['0', '65', '-1', '1.5', '0x10', '8abc'])('rejects %s', (value) => {
    expect(messageOf(() => readInt({ N: value }, 'N', opts))).toMatch(
      /N must be an integer between 1 and 64/,
    );
  });
});

describe('readEnum', () => {
  it('returns the fallback when unset and accepts allowed values', () => {
    expect(readEnum({}, 'LOG_LEVEL', ['info', 'debug'] as const, 'info')).toBe('info');
    expect(readEnum({ LOG_LEVEL: 'debug' }, 'LOG_LEVEL', ['info', 'debug'] as const, 'info')).toBe(
      'debug',
    );
  });
  it('rejects anything else', () => {
    expect(
      messageOf(() => readEnum({ LOG_LEVEL: 'loud' }, 'LOG_LEVEL', ['info'] as const, 'info')),
    ).toMatch(/LOG_LEVEL must be one of info/);
  });
});
