import type { RefusalCode } from '@feedbouncer/comments';
import { ApiError, type ErrorCode } from '../http/errors.js';

const REFUSALS: Record<Exclude<RefusalCode, 'not_found'>, [number, ErrorCode]> = {
  unsupported: [422, 'unsupported_action'],
  request_key_conflict: [409, 'request_key_conflict'],
  connection_needs_reconnect: [409, 'connection_needs_reconnect'],
  connection_inactive: [409, 'connection_inactive'],
  review_mode_active: [409, 'review_mode_active'],
  // Only refuses automation; a person's request never gets here.
  moderator_override: [403, 'forbidden'],
};

export function throwRefusal(code: Exclude<RefusalCode, 'not_found'>): never {
  const [status, error] = REFUSALS[code];
  throw new ApiError(status, error);
}
