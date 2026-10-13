import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  a = await seedTenant(ctx.c, 'iga');
  b = await seedTenant(ctx.c, 'igb');
});
afterAll(() => ctx.close());

// Each statement runs on its own (autocommit); only the SQLSTATE is compared.
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );
const ins = (t: Tenant, platform: string, account: string, status = 'active') =>
  ctx.c.query(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status, status_reason)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 = 'revoked' THEN 'user_disconnected' END)`,
    [t.organizationId, t.brandId, platform, account, status],
  );

describe('one live instagram connection per account', () => {
  it('refuses a second live connection from another brand', async () => {
    const ig = `1784${Date.now()}`;
    await ins(a, 'instagram', ig);
    expect(await code(ins(b, 'instagram', ig))).toBe('23505');
  });

  it('allows it once the first is revoked', async () => {
    const ig = `1785${Date.now()}`;
    await ins(a, 'instagram', ig, 'revoked');
    expect(await code(ins(b, 'instagram', ig))).toBe('ok');
  });

  it('a facebook page id equal to an instagram id does not collide', async () => {
    const id = `1786${Date.now()}`;
    await ins(a, 'facebook', id);
    expect(await code(ins(b, 'instagram', id))).toBe('ok');
  });
});
