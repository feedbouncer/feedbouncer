import { describe, expect, it } from 'vitest';
import { createLogger, errorFields, redact } from './logger.js';

describe('createLogger', () => {
  it('writes one JSON object per line with service, level, msg and time', () => {
    const lines: string[] = [];
    createLogger('api', 'info', (l) => lines.push(l)).info('started', { port: 3001 });
    const entry = JSON.parse(lines[0] ?? '');
    expect(entry).toMatchObject({ service: 'api', level: 'info', msg: 'started', port: 3001 });
    expect(typeof entry.time).toBe('string');
  });

  it('drops entries below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger('api', 'warn', (l) => lines.push(l));
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['c', 'd']);
  });

  it('redacts URL credentials in messages and string fields', () => {
    const lines: string[] = [];
    createLogger('api', 'info', (l) => lines.push(l)).info(
      'cannot reach postgresql://u:hunter2@db/x',
      {
        url: 'redis://:hunter2@redis:6379',
      },
    );
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('redact', () => {
  it('replaces userinfo in URLs', () => {
    expect(redact('postgresql://fb:secret@postgres:5432/db')).toBe(
      'postgresql://[redacted]@postgres:5432/db',
    );
    expect(redact('no url here')).toBe('no url here');
  });

  it('redacts the whole userinfo when the password contains @', () => {
    expect(redact('postgres://u:p@ss@db/x')).toBe('postgres://[redacted]@db/x');
  });

  it('redacts the whole userinfo when the password contains /', () => {
    expect(redact('postgres://u:p/ss@db/x')).toBe('postgres://[redacted]@db/x');
  });

  it('redacts every URL in a string without eating text between them', () => {
    expect(redact('a postgres://u:p@ss@db/x and redis://:pw@r:6379 done')).toBe(
      'a postgres://[redacted]@db/x and redis://[redacted]@r:6379 done',
    );
  });

  it('leaves credential-less URLs alone, including @ in path or query', () => {
    for (const url of [
      'http://host/a@b',
      'http://host:80/a@b',
      'https://h/p?email=a@b.c',
      'http://[::1]:8080/x@y',
    ]) {
      expect(redact(`see ${url} now`)).toBe(`see ${url} now`);
    }
  });

  it('stops at quotes and angle brackets', () => {
    expect(redact('"postgres://u:pw@db/x" <redis://:pw@r>')).toBe(
      '"postgres://[redacted]@db/x" <redis://[redacted]@r>',
    );
  });

  it('masks key=value secrets in DSNs and query strings', () => {
    expect(redact('host=x password=hunter2 dbname=y')).toBe('host=x password=[redacted] dbname=y');
    expect(redact('postgres://h/db?sslpassword=abc&sslmode=require')).toBe(
      'postgres://h/db?sslpassword=[redacted]&sslmode=require',
    );
    expect(redact('api_key: k123, TOKEN=t0k')).toBe('api_key: [redacted], TOKEN=[redacted]');
  });
});

describe('errorFields', () => {
  it('keeps name and code, redacts the message', () => {
    const err = Object.assign(new Error('connect to postgresql://u:pw@h/db failed'), {
      code: 'ECONNREFUSED',
    });
    expect(errorFields(err)).toEqual({
      error: 'Error',
      errorCode: 'ECONNREFUSED',
      errorMessage: 'connect to postgresql://[redacted]@h/db failed',
    });
  });
  it('handles non-Error throws', () => {
    expect(errorFields('boom')).toEqual({ error: 'NonError', errorCode: null, errorMessage: null });
  });
});
