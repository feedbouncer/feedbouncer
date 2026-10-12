import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(() => ctx.close());

async function seedLedgerRow(t: Tenant): Promise<string> {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key, payload, expires_at)
     VALUES ($1, $2, $3, 'facebook', 'hide_comment', repeat('a', 64), '{}'::jsonb, now() + interval '1 day') RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId],
  );
  return r.rows[0]!.id;
}

describe('connection_sync', () => {
  it('follows its connection and rejects bad codes', async () => {
    const t = await seedTenant(ctx.c, 'obs-a');
    await ctx.c.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at) VALUES ($1, $2, $3, now())`,
      [t.connectionId, t.organizationId, t.brandId],
    );
    await expectPgError(
      ctx.c.query(
        `UPDATE connection_sync SET last_error_code = 'Bad Code', last_error_class = 'retryable', last_failure_at = now()`,
      ),
      '23514',
    );
    await expectPgError(
      ctx.c.query(
        `UPDATE connection_sync SET last_error_code = 'upstream_5xx', last_error_class = NULL, last_failure_at = now()`,
      ),
      '23514',
    );
    await ctx.c.query('DELETE FROM connection WHERE id = $1', [t.connectionId]);
    const left = await ctx.c.query('SELECT 1 FROM connection_sync WHERE connection_id = $1', [
      t.connectionId,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("cannot point at another tenant's connection", async () => {
    const a = await seedTenant(ctx.c, 'obs-b');
    const b = await seedTenant(ctx.c, 'obs-c');
    await expectPgError(
      ctx.c.query(
        `INSERT INTO connection_sync (connection_id, organization_id, brand_id) VALUES ($1, $2, $3)`,
        [b.connectionId, a.organizationId, a.brandId],
      ),
      '23503',
    );
  });
});

describe('job_ledger.trace_context', () => {
  it('only accepts W3C traceparents', async () => {
    const id = await seedLedgerRow(await seedTenant(ctx.c, 'obs-d'));
    await ctx.c.query(`UPDATE job_ledger SET trace_context = $2 WHERE id = $1`, [
      id,
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    ]);
    await expectPgError(
      ctx.c.query(`UPDATE job_ledger SET trace_context = 'x' WHERE id = $1`, [id]),
      '23514',
    );
  });
});
