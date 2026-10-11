import type pg from 'pg';
import type { Role } from '@feedbouncer/authz';
import { notFound } from '../http/errors.js';
import { findMembership } from './memberships.repo.js';
import type { OrgContext } from './org-access.guard.js';

// Serializes every membership/invitation mutation in one organization.
// Always take this FIRST in the transaction (lock order: organization, then membership/invitation rows).
export async function lockOrganization(c: pg.PoolClient, organizationId: string): Promise<boolean> {
  const { rowCount } = await c.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE', [
    organizationId,
  ]);
  return rowCount === 1;
}

export async function currentRole(
  c: pg.PoolClient,
  organizationId: string,
  userId: string,
): Promise<Role | null> {
  return (await findMembership(c, organizationId, userId))?.role ?? null;
}

// Every membership/invitation mutation calls this first: locks the org row,
// then re-reads the actor's own role inside the transaction (never trusts
// the role the guard read before the lock).
export async function lockedActor(c: pg.PoolClient, ctx: OrgContext): Promise<Role> {
  if (!(await lockOrganization(c, ctx.organizationId))) throw notFound();
  const role = await currentRole(c, ctx.organizationId, ctx.actorUserId);
  if (!role) throw notFound(); // removed since the guard ran
  return role;
}
