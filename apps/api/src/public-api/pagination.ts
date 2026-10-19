import { decodeCursor, InvalidCursorError } from '@feedbouncer/public-api';
import { ApiError } from '../http/errors.js';

type Filters = Parameters<typeof decodeCursor>[1];

/** The position a cursor points at, or undefined for the first page. A bad cursor is a 400. */
export function decodePageCursor(
  cursor: string | undefined,
  filters: Filters,
): { t: Date; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    return decodeCursor(cursor, filters);
  } catch (err) {
    if (err instanceof InvalidCursorError) throw new ApiError(400, 'invalid_cursor');
    throw err;
  }
}

/** Parses an optional ISO range and rejects one that does not start before it ends. */
export function parseDateRange(
  from: string | undefined,
  to: string | undefined,
  names: { from: string; to: string },
): { from: Date | undefined; to: Date | undefined } {
  const range = { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
  if (range.from && range.to && range.from >= range.to) {
    throw new ApiError(400, 'invalid_request', `${names.from} must be before ${names.to}.`);
  }
  return range;
}
