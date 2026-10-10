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
