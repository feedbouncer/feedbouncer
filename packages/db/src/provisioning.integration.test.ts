import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { recordProvisioningAudit } from './provisioning-audit.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;

beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(async () => {
  await ctx.close();
});

const newUser = (email: string, ref: string | null = null) =>
  ctx.c.query('INSERT INTO app_user (email, external_ref) VALUES ($1, $2) RETURNING id', [
    email,
    ref,
  ]);
const newOrg = (ref: string | null = null) =>
  ctx.c.query('INSERT INTO organization (name, external_ref) VALUES ($1, $2) RETURNING id', [
    'Org',
    ref,
  ]);

describe('provisioning data model', () => {
  it('existing users default to active and have no external ref', async () => {
    const t = await seedTenant(ctx.c, 'prov-default');
    const { rows } = await ctx.c.query('SELECT status, external_ref FROM app_user WHERE id = $1', [
      t.userId,
    ]);
    expect(rows[0]).toEqual({ status: 'active', external_ref: null });
  });

  it('rejects unknown user status', async () => {
    const t = await seedTenant(ctx.c, 'prov-status');
    await expect(
      ctx.c.query(`UPDATE app_user SET status = 'paused' WHERE id = $1`, [t.userId]),
    ).rejects.toMatchObject({ constraint: 'app_user_status_check' });
  });

  it('app_user external_ref is unique when set and optional', async () => {
    await newUser('a1@example.com');
    await newUser('a2@example.com');
    await newUser('a3@example.com', 'ref-u');
    await expect(newUser('a4@example.com', 'ref-u')).rejects.toMatchObject({
      constraint: 'app_user_external_ref_key',
    });
  });

  it('organization external_ref is unique when set and optional', async () => {
    await newOrg();
    await newOrg();
    await newOrg('ref-o');
    await expect(newOrg('ref-o')).rejects.toMatchObject({
      constraint: 'organization_external_ref_key',
    });
  });

  it.each(['<script>', '', 'x'.repeat(201)])('external_ref rejects bad shape %#', async (bad) => {
    await expect(newUser(`bad${bad.length}@example.com`, bad)).rejects.toMatchObject({
      constraint: 'app_user_external_ref_check',
    });
    await expect(newOrg(bad)).rejects.toMatchObject({
      constraint: 'organization_external_ref_check',
    });
  });

  it('provisioning audit is append-only', async () => {
    await recordProvisioningAudit(ctx.c, {
      action: 'user.create',
      targetType: 'user',
      targetId: null,
      outcome: 'not_found',
      credentialFingerprint: 'abcdef012345',
      details: { errorCode: 'x' },
    });
    const forbidden = (op: string) => ({
      code: '23001',
      message: `provisioning_audit_event is append-only: ${op} is not allowed`,
    });
    await expect(
      ctx.c.query(`UPDATE provisioning_audit_event SET outcome = 'read'`),
    ).rejects.toMatchObject(forbidden('UPDATE'));
    await expect(ctx.c.query('DELETE FROM provisioning_audit_event')).rejects.toMatchObject(
      forbidden('DELETE'),
    );
    await expect(ctx.c.query('TRUNCATE provisioning_audit_event')).rejects.toMatchObject(
      forbidden('TRUNCATE'),
    );
  });

  it('rejects a malformed credential fingerprint', async () => {
    await expect(
      recordProvisioningAudit(ctx.c, {
        action: 'user.read',
        targetType: 'user',
        targetId: null,
        outcome: 'read',
        credentialFingerprint: 'NOT-HEX',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
