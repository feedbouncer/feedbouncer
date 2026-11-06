import { orgStatusOf } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';
import { ApiError } from '../http/errors.js';

export interface OrgStatusCheck {
  organizationId: string;
  rawStatus: unknown;
  via: 'session' | 'api_key';
  route: string;
  userId?: string;
  apiKeyId?: string;
}

/** Fails closed: anything but a recognized `active` status is denied. */
export function enforceOrgActive(log: Pick<Logger, 'info' | 'error'>, c: OrgStatusCheck): void {
  const { status, recognized } = orgStatusOf(c.rawStatus);
  if (!recognized) log.error('org.status_unrecognized', { orgId: c.organizationId, via: c.via });
  if (status === 'active') return;
  log.info('org.access_denied_suspended', {
    orgId: c.organizationId,
    via: c.via,
    route: c.route,
    ...(c.userId && { userId: c.userId }),
    ...(c.apiKeyId && { apiKeyId: c.apiKeyId }),
  });
  throw new ApiError(403, 'organization_suspended');
}
