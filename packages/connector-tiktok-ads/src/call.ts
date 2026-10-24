import { ConnectorError, type CallContext } from '@feedbouncer/connectors';
import type { TikTokCall } from '@feedbouncer/tiktok-business-api';

export type SkipLog = (msg: string, fields: { code: string; count?: number }) => void;

export const callOf = (ctx: CallContext): TikTokCall => ({
  http: ctx.http,
  signal: ctx.signal,
  accessToken: ctx.accessToken.reveal(),
  reportQuota: ctx.reportQuota,
});

/** The grant lacks comment management; the user has to authorise again. */
export const scopeMissing = () =>
  new ConnectorError('auth_expired', 'scope_missing', {
    reauthorize: true,
    missingScopes: ['comment_management'],
  });

/** Runs `fn`, turning a permission_denied into `scope_missing`. */
export async function scoped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof ConnectorError && e.code === 'permission_denied' ? scopeMissing() : e;
  }
}
