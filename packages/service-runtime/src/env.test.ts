import { describe, expect, it } from 'vitest';
import {
  EnvError,
  PG_PROTOCOLS,
  REDIS_PROTOCOLS,
  readAppEnv,
  readEnum,
  readInt,
  readRequiredString,
  readSecret,
  readString,
  readUrl,
  resolveFileEnv,
  type SecretFileSystem,
} from './env.js';

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

describe('readSecret', () => {
  it('requires the minimum length and never echoes the value', () => {
    expect(() => readSecret({ S: 'short' }, 'S', { minLength: 32 })).toThrow(
      /S must be at least 32 characters/,
    );
    expect(
      messageOf(() => readSecret({ S: 'short-secret' }, 'S', { minLength: 32 })),
    ).not.toContain('short-secret');
    expect(readSecret({ S: 'x'.repeat(32) }, 'S', { minLength: 32 })).toBe('x'.repeat(32));
  });
  it('is required', () => {
    expect(messageOf(() => readSecret({}, 'S', { minLength: 32 }))).toMatch(/S is not set/);
  });
});

describe('readString', () => {
  it('falls back, enforces length and pattern', () => {
    expect(readString({}, 'M', { fallback: 'a', maxLength: 5 })).toBe('a');
    expect(() => readString({ M: 'abcdef' }, 'M', { fallback: 'a', maxLength: 5 })).toThrow(/M/);
    expect(() =>
      readString({ M: 'a\nb' }, 'M', { fallback: 'a', maxLength: 5, pattern: /^[^\n]+$/ }),
    ).toThrow(/M/);
    expect(
      messageOf(() => readString({ M: 'abcdef' }, 'M', { fallback: 'a', maxLength: 5 })),
    ).not.toContain('abcdef');
  });
  it('names the check that failed', () => {
    expect(messageOf(() => readString({ M: 'abcdef' }, 'M', { fallback: 'a', maxLength: 5 }))).toBe(
      'M is not valid (at most 5 characters).',
    );
    expect(
      messageOf(() =>
        readString({ M: 'a\nb' }, 'M', { fallback: 'a', maxLength: 5, pattern: /^[^\n]+$/ }),
      ),
    ).toBe('M is not valid (unexpected format).');
  });
});

function fakeFs(files: Record<string, string | 'dir'>): SecretFileSystem {
  return {
    size: (p) => {
      const f = files[p];
      if (f === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return f === 'dir' ? 'not-a-file' : Buffer.byteLength(f);
    },
    read: (p) => {
      const f = files[p];
      if (f === undefined || f === 'dir') throw new Error('EISDIR');
      return f;
    },
  };
}

describe('resolveFileEnv', () => {
  const VALUE = 'file-secret-value-0123456789abcdef';

  it('reads NAME from NAME_FILE and strips one trailing LF or CRLF', () => {
    for (const content of [VALUE, `${VALUE}\n`, `${VALUE}\r\n`]) {
      const env = resolveFileEnv(
        { AUTH_SECRET_FILE: '/run/secrets/auth' },
        ['AUTH_SECRET'],
        fakeFs({ '/run/secrets/auth': content }),
      );
      expect(env.AUTH_SECRET).toBe(VALUE);
      expect(env.AUTH_SECRET_FILE).toBeUndefined();
    }
  });

  it('leaves env untouched when NAME_FILE is not set', () => {
    expect(resolveFileEnv({ AUTH_SECRET: VALUE }, ['AUTH_SECRET'], fakeFs({}))).toEqual({
      AUTH_SECRET: VALUE,
    });
  });

  it('ignores _FILE for names not in the list', () => {
    expect(resolveFileEnv({ OTHER_FILE: '/x' }, ['AUTH_SECRET'], fakeFs({})).OTHER_FILE).toBe('/x');
  });

  it.each([
    [
      { AUTH_SECRET: VALUE, AUTH_SECRET_FILE: '/a' },
      { '/a': VALUE },
      /Set either AUTH_SECRET or AUTH_SECRET_FILE, not both/,
    ],
    [{ AUTH_SECRET_FILE: 'relative/path' }, {}, /AUTH_SECRET_FILE must be an absolute path/],
    [
      { AUTH_SECRET_FILE: '/missing' },
      {},
      /AUTH_SECRET_FILE points to a file that does not exist or cannot be read/,
    ],
    [
      { AUTH_SECRET_FILE: '/dir' },
      { '/dir': 'dir' },
      /AUTH_SECRET_FILE must point to a regular file/,
    ],
    [
      { AUTH_SECRET_FILE: '/big' },
      { '/big': 'x'.repeat(65_537) },
      /AUTH_SECRET_FILE points to a file larger than 65536 bytes/,
    ],
    [
      { AUTH_SECRET_FILE: '/empty' },
      { '/empty': '\n' },
      /AUTH_SECRET_FILE points to an empty file/,
    ],
  ] as const)('rejects %o with a value-free message', (env, files, pattern) => {
    const msg = messageOf(() => resolveFileEnv(env, ['AUTH_SECRET'], fakeFs(files)));
    expect(msg).toMatch(pattern);
    expect(msg).not.toContain(VALUE);
  });

  it('follows symlinks via the real filesystem (Kubernetes secret mounts)', async () => {
    const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fb-secret-'));
    try {
      await writeFile(join(dir, 'real'), `${VALUE}\n`, { mode: 0o600 });
      await symlink(join(dir, 'real'), join(dir, 'link'));
      expect(
        resolveFileEnv({ AUTH_SECRET_FILE: join(dir, 'link') }, ['AUTH_SECRET']).AUTH_SECRET,
      ).toBe(VALUE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readAppEnv', () => {
  it('defaults to production when FB_ENV is unset', () => {
    expect(readAppEnv({})).toBe('production');
  });
  it('accepts development, test and production', () => {
    for (const v of ['development', 'test', 'production'] as const)
      expect(readAppEnv({ FB_ENV: v })).toBe(v);
  });
  it('rejects anything else', () => {
    expect(messageOf(() => readAppEnv({ FB_ENV: 'prod' }))).toMatch(
      /FB_ENV must be one of development, test, production/,
    );
  });
});

describe('readRequiredString', () => {
  it('requires the value and checks the pattern without echoing it', () => {
    expect(messageOf(() => readRequiredString({}, 'X', { maxLength: 5, pattern: /^a+$/ }))).toMatch(
      /X is not set/,
    );
    const msg = messageOf(() =>
      readRequiredString({ X: 'bbb' }, 'X', { maxLength: 5, pattern: /^a+$/ }),
    );
    expect(msg).toMatch(/X is not valid/);
    expect(msg).not.toContain('bbb');
    expect(readRequiredString({ X: 'aaa' }, 'X', { maxLength: 5, pattern: /^a+$/ })).toBe('aaa');
  });
});
