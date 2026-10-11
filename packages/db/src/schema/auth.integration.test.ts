import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, uuid } from '../testing/fixtures.js';
import { isOwnerRequiredViolation } from '../pg-errors.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(() => ctx.close());

async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await ctx.c.query('BEGIN');
  try {
    const r = await fn();
    await ctx.c.query('COMMIT');
    return r;
  } catch (e) {
    await ctx.c.query('ROLLBACK');
    throw e;
  }
}
const ownerCount = async (org: string) =>
  (
    await ctx.c.query(
      "SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND role = 'owner'",
      [org],
    )
  ).rows[0].n as number;

describe('app_user', () => {
  it('rejects a non-lowercase email', async () => {
    await expectPgError(
      ctx.c.query("INSERT INTO app_user (email) VALUES ('Ana@X.test')"),
      '23514',
      'app_user_email_lower_check',
    );
  });
  it('defaults email_verified to false', async () => {
    const { rows } = await ctx.c.query(
      'INSERT INTO app_user (email) VALUES ($1) RETURNING email_verified',
      [`u-${uuid()}@x.test`],
    );
    expect(rows[0].email_verified).toBe(false);
  });
});

describe('last-owner trigger', () => {
  it('refuses to demote the only owner at commit', async () => {
    const t = await seedTenant(ctx.c, 'lo1');
    await expectPgError(
      tx(() =>
        ctx.c.query("UPDATE membership SET role = 'admin' WHERE organization_id = $1", [
          t.organizationId,
        ]),
      ),
      '23514',
      'membership_owner_required',
    );
    expect(await ownerCount(t.organizationId)).toBe(1);
  });
  it('refuses to delete the only owner membership', async () => {
    const t = await seedTenant(ctx.c, 'lo2');
    await expectPgError(
      tx(() =>
        ctx.c.query('DELETE FROM membership WHERE organization_id = $1', [t.organizationId]),
      ),
      '23514',
      'membership_owner_required',
    );
  });
  it('refuses to delete a user who is the sole owner (account deletion backstop)', async () => {
    const t = await seedTenant(ctx.c, 'lo3');
    await expectPgError(
      tx(() => ctx.c.query('DELETE FROM app_user WHERE id = $1', [t.userId])),
      '23514',
      'membership_owner_required',
    );
  });
  it('allows demotion when a second owner exists in the same transaction', async () => {
    const t = await seedTenant(ctx.c, 'lo4');
    const u2 = (
      await ctx.c.query('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
        `o2-${uuid()}@x.test`,
      ])
    ).rows[0].id;
    await tx(async () => {
      await ctx.c.query(
        "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [t.organizationId, u2],
      );
      await ctx.c.query(
        "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
        [t.organizationId, t.userId],
      );
    });
    expect(await ownerCount(t.organizationId)).toBe(1);
  });
  it('allows deleting the whole organization', async () => {
    const t = await seedTenant(ctx.c, 'lo5');
    await tx(() => ctx.c.query('DELETE FROM organization WHERE id = $1', [t.organizationId]));
  });
});

describe('last-owner trigger under concurrency', () => {
  it('lets only one of two concurrent owner removals commit', async () => {
    const a = await ctx.db.client();
    const b = await ctx.db.client();
    try {
      for (const c of [a, b]) await c.query("SET statement_timeout = '20s'");
      // The race window is narrow, so repeat it. Without the organization row
      // lock in fb_require_org_owner, at least one round ends with no owner.
      for (let round = 0; round < 25; round++) {
        const t = await seedTenant(ctx.c, `lo-race-${round}`);
        const second = (
          await ctx.c.query('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
            `race-${uuid()}@x.test`,
          ])
        ).rows[0].id as string;
        await ctx.c.query(
          "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
          [t.organizationId, second],
        );
        await a.query('BEGIN');
        await b.query('BEGIN');
        await a.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
          t.organizationId,
          t.userId,
        ]);
        await b.query(
          "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
          [t.organizationId, second],
        );
        const results = await Promise.allSettled([a.query('COMMIT'), b.query('COMMIT')]);
        for (const c of [a, b]) await c.query('ROLLBACK');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(isOwnerRequiredViolation((rejected[0] as PromiseRejectedResult).reason)).toBe(true);
        expect(await ownerCount(t.organizationId)).toBe(1);
      }
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('brand names', () => {
  it('are unique per organization, case- and whitespace-insensitively, among active brands', async () => {
    const t = await seedTenant(ctx.c, 'bn1');
    await ctx.c.query("INSERT INTO brand (organization_id, name) VALUES ($1, 'Acme')", [
      t.organizationId,
    ]);
    await expectPgError(
      ctx.c.query("INSERT INTO brand (organization_id, name) VALUES ($1, ' acme ')", [
        t.organizationId,
      ]),
      '23505',
      'brand_organization_id_name_key',
    );
    await ctx.c.query(
      "UPDATE brand SET archived_at = now() WHERE organization_id = $1 AND name = 'Acme'",
      [t.organizationId],
    );
    await ctx.c.query("INSERT INTO brand (organization_id, name) VALUES ($1, 'Acme')", [
      t.organizationId,
    ]);
  });
  it('may repeat across organizations', async () => {
    const a = await seedTenant(ctx.c, 'bn2');
    const b = await seedTenant(ctx.c, 'bn3');
    await ctx.c.query("INSERT INTO brand (organization_id, name) VALUES ($1, 'Shared')", [
      a.organizationId,
    ]);
    await ctx.c.query("INSERT INTO brand (organization_id, name) VALUES ($1, 'Shared')", [
      b.organizationId,
    ]);
  });
});

describe('invitation', () => {
  const hash = () => randomBytes(32);
  it('allows one pending invite per (organization, email)', async () => {
    const t = await seedTenant(ctx.c, 'inv1');
    const ins = () =>
      ctx.c.query(
        "INSERT INTO invitation (organization_id, email, role, token_hash, expires_at) VALUES ($1, 'x@y.test', 'member', $2, now() + interval '7 days')",
        [t.organizationId, hash()],
      );
    await ins();
    await expectPgError(ins(), '23505', 'invitation_organization_id_email_key');
  });
  it('rejects an accepted invite without accepted_at', async () => {
    const t = await seedTenant(ctx.c, 'inv2');
    await expectPgError(
      ctx.c.query(
        "INSERT INTO invitation (organization_id, email, role, token_hash, expires_at, status) VALUES ($1, 'x@y.test', 'member', $2, now(), 'accepted')",
        [t.organizationId, hash()],
      ),
      '23514',
      'invitation_state_check',
    );
  });
  it('rejects a token_hash that is not 32 bytes', async () => {
    const t = await seedTenant(ctx.c, 'inv3');
    await expectPgError(
      ctx.c.query(
        "INSERT INTO invitation (organization_id, email, role, token_hash, expires_at) VALUES ($1, 'x@y.test', 'member', '\\x00', now())",
        [t.organizationId],
      ),
      '23514',
      'invitation_token_hash_check',
    );
  });
});
