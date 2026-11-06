import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import {
  isOrgActive,
  isUniqueViolation,
  recordAuditEvent,
  recordProvisioningAudit,
  withTransaction,
} from '@feedbouncer/db';
import { deliverSetupEmails, type Auth } from '../auth/auth.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { AUTH, DEPS } from '../tokens.js';
import {
  ORGANIZATION_COLUMNS,
  USER_COLUMNS,
  toProvisionedOrganization,
  toProvisionedUser,
  type CreateOrganizationInput,
  type CreateUserInput,
  type MembershipRow,
  type OrganizationRow,
  type ProvisionedOrganization,
  type ProvisionedUser,
  type SetupEmail,
  type UserRow,
} from './dto.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

const EMAIL_INDEX = 'app_user_email_lower_key';
const VIA = { via: 'provisioning_api' } as const;

const mismatch = () => new ApiError(409, 'external_ref_mismatch');

/**
 * Serializes creates with one external reference until the transaction ends, so
 * concurrent same-ref requests replay instead of racing on the email index.
 */
const lockRef = (c: Queryable, key: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);

const membershipsOf = (c: Queryable, userId: string) =>
  c
    .query<MembershipRow>(
      `SELECT m.organization_id, m.role, o.status AS organization_status
         FROM membership m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY m.created_at, m.organization_id`,
      [userId],
    )
    .then((r) => r.rows);

/**
 * The provisioning operations. Each success writes its own provisioning audit row
 * (inside the change's transaction for writes); errors are audited by the controller.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async getOrganization(fp: string, id: string): Promise<ProvisionedOrganization> {
    const { rows } = await this.deps.pool.query<OrganizationRow>(
      `SELECT ${ORGANIZATION_COLUMNS} FROM organization WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound();
    await recordProvisioningAudit(this.deps.pool, {
      action: 'organization.read',
      targetType: 'organization',
      targetId: id,
      outcome: 'read',
      credentialFingerprint: fp,
    });
    return toProvisionedOrganization(rows[0]);
  }

  async getUser(fp: string, id: string): Promise<ProvisionedUser> {
    const { rows } = await this.deps.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM app_user WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound();
    const memberships = await membershipsOf(this.deps.pool, id);
    await recordProvisioningAudit(this.deps.pool, {
      action: 'user.read',
      targetType: 'user',
      targetId: id,
      outcome: 'read',
      credentialFingerprint: fp,
    });
    return toProvisionedUser(rows[0], memberships);
  }

  /** Creates the organization, or replays the one created with this external reference. */
  createOrganization(
    fp: string,
    body: CreateOrganizationInput,
  ): Promise<{ organization: ProvisionedOrganization; replayed: boolean }> {
    return withTransaction(this.deps.pool, async (c) => {
      await lockRef(c, `fb:prov:org:${body.externalRef}`);
      const found = (
        await c.query<OrganizationRow>(
          `SELECT ${ORGANIZATION_COLUMNS} FROM organization WHERE external_ref = $1`,
          [body.externalRef],
        )
      ).rows[0];
      if (found && found.name !== body.name) throw mismatch();
      const org =
        found ??
        (
          await c.query<OrganizationRow>(
            `INSERT INTO organization (name, external_ref) VALUES ($1, $2)
             RETURNING ${ORGANIZATION_COLUMNS}`,
            [body.name, body.externalRef],
          )
        ).rows[0]!;
      if (!found) {
        await recordAuditEvent(c, {
          organizationId: org.id,
          actorType: 'system',
          action: 'organization.created',
          subjectType: 'organization',
          subjectId: org.id,
          details: VIA,
        });
      }
      await recordProvisioningAudit(c, {
        action: 'organization.create',
        targetType: 'organization',
        targetId: org.id,
        outcome: found ? 'replayed' : 'created',
        credentialFingerprint: fp,
      });
      return { organization: toProvisionedOrganization(org), replayed: !!found };
    });
  }

  /**
   * Creates a user without a password and their membership, or replays the user
   * created with this external reference. A new user is then sent the setup email
   * unless sendSetupEmail is false; its failure does not undo the create.
   */
  async createUser(
    fp: string,
    organizationId: string,
    body: CreateUserInput,
  ): Promise<{ user: ProvisionedUser; replayed: boolean; setupEmail: SetupEmail }> {
    const { user, replayed } = await withTransaction(this.deps.pool, async (c) => {
      await lockRef(c, `fb:prov:user:${body.externalRef}`);
      const found = (
        await c.query<UserRow>(`SELECT ${USER_COLUMNS} FROM app_user WHERE external_ref = $1`, [
          body.externalRef,
        ])
      ).rows[0];
      if (found) {
        const memberships = await membershipsOf(c, found.id);
        const same =
          found.email === body.email &&
          found.display_name === body.name &&
          memberships.some((m) => m.organization_id === organizationId && m.role === body.role);
        if (!same) throw mismatch();
        await recordProvisioningAudit(c, {
          action: 'user.create',
          targetType: 'user',
          targetId: found.id,
          outcome: 'replayed',
          credentialFingerprint: fp,
        });
        return { user: toProvisionedUser(found, memberships), replayed: true };
      }

      // FOR SHARE conflicts with a status change's FOR UPDATE: the check cannot race it.
      const org = (
        await c.query<{ status: string }>(
          'SELECT status FROM organization WHERE id = $1 FOR SHARE',
          [organizationId],
        )
      ).rows[0];
      if (!org) throw notFound();
      if (!isOrgActive(org.status) && !body.allowInactiveOrganization) {
        throw new ApiError(409, 'organization_inactive');
      }
      let row: UserRow;
      try {
        row = (
          await c.query<UserRow>(
            `INSERT INTO app_user (id, email, display_name, email_verified, status, external_ref)
             VALUES (gen_random_uuid(), $1, $2, true, 'active', $3)
             RETURNING ${USER_COLUMNS}`,
            [body.email, body.name, body.externalRef],
          )
        ).rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err, EMAIL_INDEX)) throw new ApiError(409, 'email_in_use');
        throw err;
      }
      const membership = (
        await c.query<{ id: string }>(
          'INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3) RETURNING id',
          [organizationId, row.id, body.role],
        )
      ).rows[0]!;
      await recordAuditEvent(c, {
        organizationId,
        actorType: 'system',
        action: 'membership.provisioned',
        subjectType: 'membership',
        subjectId: membership.id,
        details: { role: body.role, ...VIA },
      });
      await recordProvisioningAudit(c, {
        action: 'user.create',
        targetType: 'user',
        targetId: row.id,
        outcome: 'created',
        credentialFingerprint: fp,
        details: { organizationId, role: body.role },
      });
      return { user: toProvisionedUser(row, await membershipsOf(c, row.id)), replayed: false };
    });
    const setupEmail =
      replayed || body.sendSetupEmail === false ? 'skipped' : await this.sendSetupEmail(user);
    return { user, replayed, setupEmail };
  }

  private async sendSetupEmail(user: ProvisionedUser): Promise<SetupEmail> {
    const sent = await deliverSetupEmails(() =>
      this.auth.api.requestPasswordReset({ body: { email: user.email } }),
    ).catch(() => 0);
    if (sent === 1) return 'sent';
    this.deps.log.warn('provisioning.setup_email_failed', { userId: user.id });
    return 'failed';
  }
}
