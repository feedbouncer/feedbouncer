import { parseArgs } from 'node:util';
import { isOrgStatus, recordAuditEvent, withTransaction, type OrgStatus } from '@feedbouncer/db';
import { UsageError } from '@feedbouncer/jobs';
import type { OpsCommand } from './ops-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORG_STATUS_USAGE = [
  'usage: pnpm ops org-status show <orgId>',
  '       pnpm ops org-status set <orgId> <active|suspended> --actor <userId> --reason <abuse|non_payment|customer_request|other>',
].join('\n');

export const SUSPENSION_REASONS = ['abuse', 'non_payment', 'customer_request', 'other'] as const;

type OrgStatusErrorCode = 'org_not_found' | 'actor_not_found';

export class OrgStatusError extends Error {
  constructor(readonly code: OrgStatusErrorCode) {
    super(code);
  }
}

function uuid(value: string | undefined, name: string): string {
  if (value === undefined || !UUID.test(value)) throw new UsageError(`${name} must be a uuid`);
  return value;
}

export const orgStatusCommand: OpsCommand = async (argv, ctx) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { actor: { type: 'string' }, reason: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new UsageError('invalid arguments');
  }
  const [verb, orgArg, statusArg, ...extra] = parsed.positionals;
  const { actor, reason } = parsed.values;
  const pool = ctx.pool();

  if (verb === 'show') {
    const organizationId = uuid(orgArg, 'orgId');
    if (statusArg !== undefined || actor !== undefined || reason !== undefined)
      throw new UsageError('show takes only <orgId>');
    const org = await pool.query<{ status: string }>(
      'SELECT status FROM organization WHERE id = $1',
      [organizationId],
    );
    if (!org.rows[0]) throw new OrgStatusError('org_not_found');
    ctx.out(`${organizationId} ${org.rows[0].status}`);
    const last = await pool.query<{
      action: string;
      created_at: Date;
      actor_user_id: string | null;
      reason: string | null;
    }>(
      `SELECT action, created_at, actor_user_id, details->>'reason' AS reason
         FROM audit_event
        WHERE organization_id = $1 AND action IN ('organization.suspended', 'organization.reactivated')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [organizationId],
    );
    const row = last.rows[0];
    if (row)
      ctx.out(
        `${row.action} ${row.created_at.toISOString()} actor_user_id=${row.actor_user_id} reason=${row.reason}`,
      );
    return 0;
  }

  if (verb !== 'set' || extra.length > 0) throw new UsageError('expected show or set');
  const organizationId = uuid(orgArg, 'orgId');
  if (statusArg === undefined || !isOrgStatus(statusArg))
    throw new UsageError('status must be active or suspended');
  const to: OrgStatus = statusArg;
  const actorUserId = uuid(actor, '--actor');
  if (reason === undefined || !(SUSPENSION_REASONS as readonly string[]).includes(reason))
    throw new UsageError(`--reason must be one of: ${SUSPENSION_REASONS.join(', ')}`);

  const from = await withTransaction(pool, async (c) => {
    const org = await c.query<{ status: string }>(
      'SELECT status FROM organization WHERE id = $1 FOR UPDATE',
      [organizationId],
    );
    if (!org.rows[0]) throw new OrgStatusError('org_not_found');
    const user = await c.query('SELECT 1 FROM app_user WHERE id = $1', [actorUserId]);
    if (user.rowCount === 0) throw new OrgStatusError('actor_not_found');
    const current = org.rows[0].status;
    if (current === to) return undefined;
    await c.query('UPDATE organization SET status = $2 WHERE id = $1', [organizationId, to]);
    await recordAuditEvent(c, {
      organizationId,
      actorType: 'system',
      actorUserId,
      action: to === 'suspended' ? 'organization.suspended' : 'organization.reactivated',
      subjectType: 'organization',
      subjectId: organizationId,
      details: { from: current, to, reason, via: 'ops_cli' },
    });
    return current;
  });
  ctx.out(
    from === undefined ? `unchanged ${organizationId} ${to}` : `${organizationId} ${from} -> ${to}`,
  );
  return 0;
};
