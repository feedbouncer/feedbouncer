import { withTransaction } from '@feedbouncer/db';
import { errorFields } from '@feedbouncer/service-runtime';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';

/**
 * Audits and logs a refused privacy request. Ids and the route template only: the failure to
 * write the audit row never changes the answer, which stays a plain 403.
 */
export async function recordPrivacyDenial(
  deps: Pick<AppDeps, 'pool' | 'log'>,
  org: OrgContext,
  capability: string,
  route: string,
): Promise<void> {
  deps.log.info('privacy.access_denied', { orgId: org.organizationId, userId: org.actorUserId });
  try {
    await withTransaction(deps.pool, (tx) =>
      recordAudit(tx, {
        organizationId: org.organizationId,
        actorUserId: org.actorUserId,
        action: 'privacy.access_denied',
        subjectType: 'organization',
        subjectId: org.organizationId,
        details: { capability, route },
      }),
    );
  } catch (err) {
    deps.log.error('privacy.access_denied_audit_failed', errorFields(err));
  }
}
