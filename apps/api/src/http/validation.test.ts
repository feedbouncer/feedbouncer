import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from './errors.js';
import {
  isIanaTimeZone,
  parseBody,
  parseUuidOr404,
  zName,
  zTimeZone,
  zUuid,
} from './validation.js';

function apiErrorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected an ApiError');
}

describe('zName', () => {
  it('trims', () => expect(zName.parse('  Acme ')).toBe('Acme'));
  it.each(['', '   ', 'a'.repeat(201), 'A\u0000B', 'A\nB', 'A\u007fB', 'A\tB'])(
    'rejects %j',
    (v) => {
      expect(zName.safeParse(v).success).toBe(false);
    },
  );
  it('accepts 200 characters and non-ASCII letters', () => {
    expect(zName.parse('a'.repeat(200))).toHaveLength(200);
    expect(zName.parse('Café Ünïcode')).toBe('Café Ünïcode');
  });
});

describe('parseUuidOr404', () => {
  it('returns a valid UUID', () => {
    const id = '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f10';
    expect(parseUuidOr404(id)).toBe(id);
    expect(zUuid.safeParse(id).success).toBe(true);
  });
  it.each(['../../etc', '', undefined, 42, '1b4e28ba-2fa1-4d2b-8f3e-1c6a2d9e7f1'])(
    'is a 404 for %j',
    (v) => {
      const e = apiErrorOf(() => parseUuidOr404(v));
      expect(e.status).toBe(404);
      expect(e.code).toBe('not_found');
    },
  );
});

describe('parseBody', () => {
  const schema = z.strictObject({ name: zName });

  it('returns the parsed body', () => {
    expect(parseBody(schema, { name: ' Acme ' })).toEqual({ name: 'Acme' });
  });
  it('rejects unknown keys', () => {
    const e = apiErrorOf(() => parseBody(schema, { name: 'Acme', role: 'owner' }));
    expect(e.status).toBe(400);
    expect(e.code).toBe('invalid_request');
  });
  it('names the fields but never echoes values', () => {
    const e = apiErrorOf(() => parseBody(schema, { name: 'x'.repeat(201) + 'SENTINEL' }));
    expect(e.message).toContain('name');
    expect(e.message).not.toContain('SENTINEL');
  });
  it('treats a missing body as an empty object', () => {
    const e = apiErrorOf(() => parseBody(schema, undefined));
    expect(e.status).toBe(400);
    expect(e.message).toContain('name');
  });
  it('rejects a non-object body', () => {
    expect(apiErrorOf(() => parseBody(schema, 'name=Acme')).status).toBe(400);
  });
});

describe('time zones', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'Etc/GMT+5'])(
    'accepts %s',
    (v) => {
      expect(isIanaTimeZone(v)).toBe(true);
      expect(zTimeZone.parse(v)).toBe(v);
    },
  );
  it.each([
    '',
    'Mars/Phobos',
    'utc ',
    'America//Chicago',
    "UTC'; DROP TABLE brand;--",
    '+05:00',
    `${'A'.repeat(60)}/B`,
    42,
    null,
  ])('rejects %j', (v) => {
    expect(isIanaTimeZone(v)).toBe(false);
    expect(zTimeZone.safeParse(v).success).toBe(false);
  });
});
