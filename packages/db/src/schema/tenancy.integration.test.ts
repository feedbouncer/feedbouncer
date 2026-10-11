import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'a');
  b = await seedTenant(ctx.c, 'b');
});
afterAll(() => ctx.close());

describe('tenancy', () => {
  it('a user is a member of an organization at most once', async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'admin')",
        [a.organizationId, a.userId],
      ),
      '23505',
      'membership_organization_id_user_id_key',
    );
  });

  it('roles are a fixed set', async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'superuser')",
        [b.organizationId, a.userId],
      ),
      '23514',
      'membership_role_check',
    );
  });

  it('emails are stored lowercase and unique', async () => {
    await expectPgError(
      ctx.c.query("INSERT INTO app_user (email) VALUES ('Dana@Example.test')"),
      '23514',
      'app_user_email_lower_check',
    );
    await ctx.c.query("INSERT INTO app_user (email) VALUES ('dana@example.test')");
    await expectPgError(
      ctx.c.query("INSERT INTO app_user (email) VALUES ('dana@example.test')"),
      '23505',
      'app_user_email_lower_key',
    );
  });

  it('a connection cannot claim a brand from another organization', async () => {
    await expectPgError(
      ctx.c.query(
        "INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1, $2, 'instagram', 'x')",
        [a.organizationId, b.brandId],
      ),
      '23503',
      'connection_organization_id_brand_id_fkey',
    );
  });

  it('the same platform account may be connected under two brands, but only once per brand', async () => {
    await ctx.c.query(
      "INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1, $2, 'facebook', 'page-a')",
      [b.organizationId, b.brandId],
    );
    await expectPgError(
      ctx.c.query(
        "INSERT INTO connection (organization_id, brand_id, platform, external_account_id) VALUES ($1, $2, 'facebook', 'page-a')",
        [a.organizationId, a.brandId],
      ),
      '23505',
      'connection_brand_id_platform_external_account_id_key',
    );
  });

  it('updated_at moves on update and created_at does not', async () => {
    const before = (
      await ctx.c.query('SELECT created_at, updated_at FROM brand WHERE id = $1', [a.brandId])
    ).rows[0];
    await new Promise((r) => setTimeout(r, 20));
    await ctx.c.query("UPDATE brand SET name = 'Renamed' WHERE id = $1", [a.brandId]);
    const after = (
      await ctx.c.query('SELECT created_at, updated_at FROM brand WHERE id = $1', [a.brandId])
    ).rows[0];
    expect(after.created_at).toEqual(before.created_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('blank names are rejected', async () => {
    await expectPgError(
      ctx.c.query("INSERT INTO organization (name) VALUES ('   ')"),
      '23514',
      'organization_name_check',
    );
  });

  it('deleting an organization removes its memberships, brands and connections, and nothing of another org', async () => {
    const x = await seedTenant(ctx.c, 'x');
    await ctx.c.query('DELETE FROM organization WHERE id = $1', [x.organizationId]);
    for (const t of ['membership', 'brand', 'connection']) {
      expect(
        (
          await ctx.c.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [
            x.organizationId,
          ])
        ).rows[0].n,
        t,
      ).toBe(0);
      expect(
        (
          await ctx.c.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [
            a.organizationId,
          ])
        ).rows[0].n,
        t,
      ).toBeGreaterThan(0);
    }
    expect(
      (await ctx.c.query('SELECT count(*)::int AS n FROM app_user WHERE id = $1', [x.userId]))
        .rows[0].n,
    ).toBe(1);
  });
});
