import { describe, expect, it } from 'vitest';
import { createSafeHttp, type ConnectorError } from '@feedbouncer/connectors';
import { graphRequest } from '@feedbouncer/connector-facebook';
import { Secret } from '@feedbouncer/service-runtime';
import { mapInstagramError } from './errors.js';

// Errors are produced the way production produces them: through graphRequest, which
// records the numeric Graph codes beside the mapped error.
async function build(g: {
  code: number;
  error_subcode?: number;
  message?: string;
}): Promise<ConnectorError> {
  const fetch = async () =>
    new Response(JSON.stringify({ error: g }), {
      status: g.code === 4 ? 429 : 400,
      headers: { 'content-type': 'application/json' },
    });
  const err = await graphRequest(
    {
      http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch: fetch as never }),
      signal: AbortSignal.timeout(1000),
      version: 'v26.0',
      appSecret: new Secret('APP-SECRET'),
      token: new Secret('TOKEN'),
      nowMs: () => 0,
    },
    { method: 'GET', path: ['me'] },
  ).then(
    () => null,
    (e: unknown) => e as ConnectorError,
  );
  if (!err) throw new Error('graphRequest did not fail');
  return err;
}

describe('mapInstagramError', () => {
  it.each([
    [{ code: 10 }, 'read', { throw: { kind: 'auth_expired', code: 'permission_revoked' } }],
    [{ code: 200 }, 'moderate', { throw: { kind: 'auth_expired', code: 'permission_revoked' } }],
    [{ code: 10 }, 'private_reply', { notEligible: 'private_reply_not_permitted' }],
    [{ code: 10900 }, 'private_reply', { notEligible: 'private_reply_already_sent' }],
    [
      { code: 10, error_subcode: 2018278 },
      'private_reply',
      { notEligible: 'private_reply_window_closed' },
    ],
    [
      { code: 100, error_subcode: 2534024 },
      'private_reply',
      { notEligible: 'private_reply_nested_comment' },
    ],
    [
      { code: 100, error_subcode: 2534023 },
      'public_reply',
      { notEligible: 'reply_to_hidden_comment' },
    ],
    [
      { code: 25, error_subcode: 2207050 },
      'moderate',
      { throw: { kind: 'permanent', code: 'instagram_account_restricted' } },
    ],
    [
      { code: 9999, error_subcode: 7 },
      'moderate',
      { throw: { kind: 'permanent', code: 'instagram_error_9999_7' } },
    ],
    [
      { code: 190, error_subcode: 463 },
      'read',
      { throw: { kind: 'auth_expired', code: 'token_expired' } },
    ],
    [{ code: 4 }, 'read', { throw: { kind: 'rate_limited' } }],
    [{ code: 100, error_subcode: 33 }, 'read', { throw: { kind: 'not_found' } }],
  ] as const)('%j during %s', async (g, op, expected) => {
    expect(mapInstagramError(await build(g), op)).toMatchObject(expected);
  });

  it('never includes the raw graph message', async () => {
    const r = mapInstagramError(await build({ code: 9999, message: 'secret EAABxyz' }), 'moderate');
    expect(JSON.stringify(r)).not.toContain('EAAB');
    expect('throw' in r ? r.throw.message : '').not.toContain('EAAB');
  });
});
