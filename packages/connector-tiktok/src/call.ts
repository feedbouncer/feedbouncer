import { ConnectorError, type CallContext } from '@feedbouncer/connectors';
import type { TikTokCall } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';

export type SkipLog = (msg: string, fields: { code: string; count?: number }) => void;

export const callOf = (ctx: CallContext): TikTokCall => ({
  http: ctx.http,
  signal: ctx.signal,
  accessToken: ctx.accessToken.reveal(),
  reportQuota: ctx.reportQuota,
});

const CURSOR = /^\d{1,16}$/;
/** A cursor is a numeric offset, 0..2^53. Anything else is refused before any request. */
export function checkCursor(c: string | null): string | null {
  if (c === null) return null;
  if (!CURSOR.test(c) || !Number.isSafeInteger(Number(c))) {
    throw new ConnectorError('permanent', 'invalid_cursor');
  }
  return c;
}

/** TikTok returns numeric cursors; the Connector contract uses strings. */
export const CURSOR_SCHEMA = z
  .union([z.number(), z.string()])
  .transform(String)
  .pipe(z.string().regex(CURSOR))
  .refine((s) => Number.isSafeInteger(Number(s)));

/** Page envelope: the array is capped, its items are validated one by one by the caller. */
export const pageSchema = <K extends string>(key: K) =>
  z.object({
    [key]: z.array(z.unknown()).max(500),
    cursor: CURSOR_SCHEMA.optional(),
    has_more: z.boolean().optional(),
  } as { [P in K]: z.ZodArray<z.ZodUnknown> } & {
    cursor: z.ZodOptional<typeof CURSOR_SCHEMA>;
    has_more: z.ZodOptional<z.ZodBoolean>;
  });

export const isPermissionDenied = (e: unknown): boolean =>
  e instanceof ConnectorError && e.code === 'permission_denied';

export const scopeMissing = (...missingScopes: string[]) =>
  new ConnectorError('auth_expired', 'scope_missing', { reauthorize: true, missingScopes });

export function nextCursor(p: { cursor?: string | undefined; has_more?: boolean | undefined }) {
  if (!p.has_more) return null;
  if (p.cursor === undefined) throw new ConnectorError('permanent', 'invalid_tiktok_response');
  return p.cursor;
}

/** Runs `fn`, turning a permission_denied into the error the caller's context calls for. */
export async function onPermissionDenied<T>(fn: () => Promise<T>, to: () => Error): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw isPermissionDenied(e) ? to() : e;
  }
}
