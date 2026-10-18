import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { INGEST_JOB } from '@feedbouncer/comments';
import { PgJobLedger } from '@feedbouncer/jobs';
import { loadHealthPolicy } from './policy.js';
import { HEALTH_SQL, PgHealthReader } from './pg-reader.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let A: Tenant;
let B: Tenant;
const policy = loadHealthPolicy({});

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'health-reader-test', onIdleError: () => {} });
  A = await seedTenant(h.c, 'health-a');
  B = await seedTenant(h.c, 'health-b');
  const c = h.c;
  await c.query("UPDATE connection SET platform = 'youtube' WHERE id = ANY($1)", [
    [A.connectionId, B.connectionId],
  ]);
  await c.query(
    `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
     VALUES ($1, $2, $3, now() - interval '5 minutes')`,
    [A.connectionId, A.organizationId, A.brandId],
  );
  // Smallest well-formed envelope v1 for key id "k1" (the table CHECK rejects anything else):
  // version, key id length, key id, wrapped key length (1), wrapped key, IV, tag, ciphertext.
  const envelope = Buffer.concat([
    Buffer.from([1, 2]),
    Buffer.from('k1'),
    Buffer.from([0, 1]),
    Buffer.alloc(1 + 12 + 16 + 1),
  ]);
  await c.query(
    `INSERT INTO connection_secret (organization_id, brand_id, connection_id, kind, key_id, encrypted_value, expires_at)
     VALUES ($1, $2, $3, 'access_token', 'k1', $4, now() + interval '1 hour')`,
    [A.organizationId, A.brandId, A.connectionId, envelope],
  );
  await c.query(
    `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                             payload, state, expires_at, created_at)
     VALUES ($1, $2, $3, 'youtube', 'poll', repeat('a', 64), '{}'::jsonb, 'queued', now() + interval '1 day',
             now() - interval '20 minutes')`,
    [A.organizationId, A.brandId, A.connectionId],
  );
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

describe('PgHealthReader', () => {
  it("forBrand returns only that tenant's connections", async () => {
    const r = new PgHealthReader(pool, policy);
    const a = await r.forBrand(A.organizationId, A.brandId);
    expect(a.map((x) => x.connectionId)).toEqual([A.connectionId]);
    expect(a[0]).toMatchObject({ status: 'degraded', reason: 'ingest_lag' });
    expect(a[0]!.ingestLagMs).toBeGreaterThanOrEqual(19 * 60_000);
    expect(await r.forBrand(A.organizationId, B.brandId)).toEqual([]);
    expect(await r.forBrand(B.organizationId, A.brandId)).toEqual([]);
  });

  it('a connection without a sync row is pending_first_sync', async () => {
    const b = await new PgHealthReader(pool, policy).forBrand(B.organizationId, B.brandId);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ status: 'pending_first_sync', stalenessMs: null, ingestLagMs: 0 });
  });

  it('all() caps rows and reports truncation', async () => {
    const r = new PgHealthReader(pool, policy);
    expect(await r.all(1)).toMatchObject({ truncated: true });
    expect((await r.all(1)).rows).toHaveLength(1);
    expect((await r.all(10)).rows.map((x) => x.status).sort()).toEqual([
      'degraded',
      'pending_first_sync',
    ]);
  });

  it('never selects encrypted_value', () => {
    expect(HEALTH_SQL).not.toContain('encrypted_value');
  });

  describe('failedImports', () => {
    let seq = 0;
    const seed = (
      t: Tenant,
      o: { type?: string; state?: string; ageDays?: number; connectionId?: string },
    ) => {
      const state = o.state ?? 'dead_lettered';
      return h.c.query(
        `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                                 payload, state, expires_at, dead_letter_reason, dead_lettered_at, resolution)
         VALUES ($1, $2, $3, 'youtube', $4, lpad($5, 64, 'f'), '{}'::jsonb, $6, now() + interval '1 day',
                 $7, CASE WHEN $8 THEN now() - make_interval(days => $9) END, $10)`,
        [
          t.organizationId,
          t.brandId,
          o.connectionId ?? t.connectionId,
          o.type ?? INGEST_JOB.type,
          String(++seq),
          state,
          'retries_exhausted',
          true,
          o.ageDays ?? 1,
          state === 'resolved' ? 'replayed' : null,
        ],
      );
    };

    it('counts only dead-lettered ingest jobs of that connection within 14 days', async () => {
      const other = await h.c.query<{ id: string }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
         VALUES ($1, $2, 'youtube', 'other-acct', 'other') RETURNING id`,
        [A.organizationId, A.brandId],
      );
      await seed(A, {});
      await seed(A, { ageDays: 13 });
      await seed(A, { ageDays: 15 });
      await seed(A, { state: 'resolved' });
      await seed(A, { type: 'poll' });
      await seed(A, { connectionId: other.rows[0]!.id });
      const rows = await new PgHealthReader(pool, policy).forBrand(A.organizationId, A.brandId);
      expect(rows.find((x) => x.connectionId === A.connectionId)!.failedImports).toBe(2);
      expect(rows.find((x) => x.connectionId === other.rows[0]!.id)!.failedImports).toBe(1);
    });

    it('forBrand of org A never counts org B jobs', async () => {
      await seed(B, {});
      await seed(B, {});
      await seed(B, {});
      const r = new PgHealthReader(pool, policy);
      const a = await r.forBrand(A.organizationId, A.brandId);
      expect(a.find((x) => x.connectionId === A.connectionId)!.failedImports).toBe(2);
      expect((await r.forBrand(B.organizationId, B.brandId))[0]!.failedImports).toBe(3);
      expect(await r.forBrand(A.organizationId, B.brandId)).toEqual([]);
    });
  });

  it('queueStats runs through the same bounded read-only path', async () => {
    const stats = await new PgJobLedger(pool).queueStats();
    expect(stats).toEqual([expect.objectContaining({ platform: 'youtube', depth: 1 })]);
  });
});
