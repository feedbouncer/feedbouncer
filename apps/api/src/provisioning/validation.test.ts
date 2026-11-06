import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { parseProvisioningBody } from './validation.js';

const Body = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(200),
  admin: z.boolean().optional(),
  ref: z.string().max(5).regex(/^a+$/).optional(),
});

function rejection(body: unknown): ApiError {
  try {
    parseProvisioningBody(Body, body);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected an ApiError');
}

describe('parseProvisioningBody', () => {
  it('returns the parsed body', () => {
    expect(parseProvisioningBody(Body, { email: 'a@b.test', name: ' A ' })).toEqual({
      email: 'a@b.test',
      name: 'A',
    });
  });

  it('lists the issues sorted by path, with unknown keys', () => {
    const e = rejection({ email: 'nope', name: '', extra: 1 });
    expect([e.status, e.code, e.message]).toEqual([400, 'invalid_request', 'Invalid fields.']);
    expect(e.details?.issues).toEqual([
      { path: 'email', message: 'invalid' },
      { path: 'extra', message: 'unknown_field' },
      { path: 'name', message: 'invalid' },
    ]);
  });

  it('reports a missing field as required and an oversized one as too_long', () => {
    expect(rejection({ name: 'a'.repeat(201) }).details?.issues).toEqual([
      { path: 'email', message: 'required' },
      { path: 'name', message: 'too_long' },
    ]);
  });

  it('reports one issue per field, the first one found', () => {
    expect(rejection({ email: 'a@b.test', name: 'A', ref: 'bbbbbbb' }).details?.issues).toEqual([
      { path: 'ref', message: 'too_long' },
    ]);
  });

  it('reports a wrong type of a present field as invalid', () => {
    expect(rejection({ email: 'a@b.test', name: 'A', admin: 'yes' }).details?.issues).toEqual([
      { path: 'admin', message: 'invalid' },
    ]);
  });

  it('treats a missing body as empty and a non-object body as invalid', () => {
    expect(rejection(undefined).details?.issues).toEqual([
      { path: 'email', message: 'required' },
      { path: 'name', message: 'required' },
    ]);
    expect(rejection(['x']).details?.issues).toEqual([{ path: 'body', message: 'invalid' }]);
  });

  it('never echoes a submitted value', () => {
    const values = ['<img src=x onerror=alert(1)>' + 'a'.repeat(300), 'secret@evil', 'sneaky'];
    const e = rejection({ email: values[1], name: values[0], extra: values[2] });
    const json = JSON.stringify({ ...e, message: e.message });
    for (const v of values) expect(json).not.toContain(v);
  });
});
