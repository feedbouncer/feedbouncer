import { ConnectorError, type CallContext } from '@feedbouncer/connectors';
import type { TikTokCall } from './request.js';

export type SkipLog = (msg: string, fields: { code: string; count?: number }) => void;

export const callOf = (ctx: CallContext): TikTokCall => ({
  http: ctx.http,
  signal: ctx.signal,
  accessToken: ctx.accessToken.reveal(),
  reportQuota: ctx.reportQuota,
});

export const isPermissionDenied = (e: unknown): boolean =>
  e instanceof ConnectorError && e.code === 'permission_denied';

export const scopeMissing = (...missingScopes: string[]) =>
  new ConnectorError('auth_expired', 'scope_missing', { reauthorize: true, missingScopes });

/** Runs `fn`, turning a permission_denied into the error the caller's context calls for. */
export async function onPermissionDenied<T>(fn: () => Promise<T>, to: () => Error): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw isPermissionDenied(e) ? to() : e;
  }
}

/** `not_found` means the target is already gone on TikTok. */
export async function gone<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === 'not_found') return null;
    throw e;
  }
}
