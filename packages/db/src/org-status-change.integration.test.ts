import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, uuid } from '@feedbouncer/db/testing';
import { changeOrganizationStatus } from './org-status-change.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;

beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(async () => {
  await ctx.close();
});

const statusOf = async (id: string) =>
  (await ctx.c.query<{ status: string }>('SELECT status FROM organization WHERE id = $1', [id]))
    .rows[0]!.status;
const audits = async (id: string) =>
  (
    await ctx.c.query(
      `SELECT actor_type, actor_user_id, action, subject_type, subject_id, details
         FROM audit_event WHERE organization_id = $1 ORDER BY sequence`,
      [id],
    )
  ).rows;

describe('changeOrganizationStatus', () => {
  it('changes and audits', async () => {
    const t = await seedTenant(ctx.c, 'osc-change');
    const r = await changeOrganizationStatus(ctx.c, {
      organizationId: t.organizationId,
      to: 'suspended',
      reason: 'abuse',
      via: 'ops_cli',
      actorUserId: t.userId,
    });
    expect(r).toEqual({ from: 'active', to: 'suspended', changed: true });
    expect(await statusOf(t.organizationId)).toBe('suspended');
    expect(await audits(t.organizationId)).toEqual([
      {
        actor_type: 'system',
        actor_user_id: t.userId,
        action: 'organization.suspended',
        subject_type: 'organization',
        subject_id: t.organizationId,
        details: { from: 'active', to: 'suspended', reason: 'abuse', via: 'ops_cli' },
      },
    ]);
  });

  it('no-op returns changed false without an audit row', async () => {
    const t = await seedTenant(ctx.c, 'osc-noop');
    const r = await changeOrganizationStatus(ctx.c, {
      organizationId: t.organizationId,
      to: 'active',
      reason: 'other',
      via: 'ops_cli',
      actorUserId: t.userId,
    });
    expect(r).toEqual({ from: 'active', to: 'active', changed: false });
    expect(await audits(t.organizationId)).toEqual([]);
  });

  it('missing org returns null', async () => {
    const r = await changeOrganizationStatus(ctx.c, {
      organizationId: uuid(),
      to: 'suspended',
      reason: 'other',
      via: 'provisioning_api',
      actorUserId: null,
    });
    expect(r).toBeNull();
  });

  it('actorUserId null is accepted for provisioning_api', async () => {
    const t = await seedTenant(ctx.c, 'osc-null');
    await ctx.c.query("UPDATE organization SET status = 'suspended' WHERE id = $1", [
      t.organizationId,
    ]);
    const r = await changeOrganizationStatus(ctx.c, {
      organizationId: t.organizationId,
      to: 'active',
      reason: 'customer_request',
      via: 'provisioning_api',
      actorUserId: null,
    });
    expect(r).toEqual({ from: 'suspended', to: 'active', changed: true });
    expect(await audits(t.organizationId)).toEqual([
      expect.objectContaining({
        actor_user_id: null,
        action: 'organization.reactivated',
        details: {
          from: 'suspended',
          to: 'active',
          reason: 'customer_request',
          via: 'provisioning_api',
        },
      }),
    ]);
  });
});
