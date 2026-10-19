import { describe, expect, it } from 'vitest';
import { ApiError, errorBody } from '../http/errors.js';
import { refusalError } from './moderation.service.js';

const body = (e: Error) => {
  expect(e).toBeInstanceOf(ApiError);
  const err = e as ApiError;
  return { status: err.status, ...errorBody(err).error };
};

describe('refusalError', () => {
  it.each(['review_mode_active', 'moderator_override'] as const)(
    'maps %s to 422 reply_not_allowed with the reason',
    (code) => {
      expect(body(refusalError({ status: 'refused', code }))).toMatchObject({
        status: 422,
        code: 'reply_not_allowed',
        reason: code,
      });
    },
  );

  it('maps text_too_long with its max', () => {
    expect(
      body(refusalError({ status: 'refused', code: 'text_too_long', max: 2200 })),
    ).toMatchObject({ status: 422, code: 'text_too_long', max: 2200 });
  });

  it.each([
    ['connection_needs_reconnect', 409, 'connection_inactive'],
    ['connection_inactive', 409, 'connection_inactive'],
    ['unsupported', 422, 'unsupported_action'],
    ['request_key_conflict', 422, 'idempotency_key_reused'],
    ['not_found', 404, 'not_found'],
  ] as const)('maps %s to %i %s', (code, status, apiCode) => {
    const out = body(refusalError({ status: 'refused', code }));
    expect(out).toMatchObject({ status, code: apiCode });
    expect(out).not.toHaveProperty('reason');
  });
});
