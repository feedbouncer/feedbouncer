import { userStatusOf } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';

export interface UserStatusCheck {
  userId: string;
  rawStatus: unknown;
  via: 'session' | 'sign_in' | 'api_key';
  apiKeyId?: string;
}

/** True when the caller must refuse. Fails closed: anything but a recognized `active` is denied. */
export function denyInactiveUser(log: Pick<Logger, 'info' | 'error'>, c: UserStatusCheck): boolean {
  const { status, recognized } = userStatusOf(c.rawStatus);
  if (!recognized) log.error('user.status_unrecognized', { userId: c.userId, via: c.via });
  if (status === 'active') return false;
  log.info('user.access_denied_inactive', {
    userId: c.userId,
    via: c.via,
    ...(c.apiKeyId && { apiKeyId: c.apiKeyId }),
  });
  return true;
}
