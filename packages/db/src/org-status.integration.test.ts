import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';

let ctx: Awaited<ReturnType<typeof migratedDb>>;

beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(async () => {
  await ctx.close();
});

describe('organization.status', () => {
  it('existing and new organizations default to active', async () => {
    const t = await seedTenant(ctx.c, 'status-default');
    const { rows } = await ctx.c.query('SELECT status FROM organization WHERE id = $1', [
      t.organizationId,
    ]);
    expect(rows[0].status).toBe('active');
  });

  it('rejects unknown statuses', async () => {
    const t = await seedTenant(ctx.c, 'status-unknown');
    await expect(
      ctx.c.query(`UPDATE organization SET status = 'paused' WHERE id = $1`, [t.organizationId]),
    ).rejects.toMatchObject({ constraint: 'organization_status_check' });
  });

  it('rejects null', async () => {
    const t = await seedTenant(ctx.c, 'status-null');
    await expect(
      ctx.c.query('UPDATE organization SET status = NULL WHERE id = $1', [t.organizationId]),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
