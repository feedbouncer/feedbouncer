import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb, seedTenant, type Tenant } from '../testing/index.js';
import { expectPgError } from '../testing/pg-error.js';

type Db = Awaited<ReturnType<typeof migratedDb>>;
let db: Db;
let t: Tenant;
let other: Tenant;
const KEY = 'a'.repeat(64);

const insert = (over: Record<string, unknown> = {}) => {
  const row = {
    organization_id: t.organizationId,
    brand_id: t.brandId,
    connection_id: t.connectionId,
    platform: 'facebook',
    job_type: 'hide_comment',
    idempotency_key: KEY,
    payload: '{"commentId":"c1"}',
    expires_at: new Date(Date.now() + 86_400_000),
    ...over,
  };
  const cols = Object.keys(row);
  return db.c.query(
    `INSERT INTO job_ledger (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(row),
  );
};

beforeAll(async () => {
  db = await migratedDb();
  t = await seedTenant(db.c, 'jl-a');
  other = await seedTenant(db.c, 'jl-b');
});
afterAll(() => db.close());

describe('job_ledger', () => {
  it('accepts a valid queued row with defaults', async () => {
    const { rows } = await insert();
    const r = await db.c.query(
      'SELECT state, failures, crashes, deferrals, deferred_ms, replays FROM job_ledger WHERE id = $1',
      [rows[0].id],
    );
    expect(r.rows[0]).toEqual({
      state: 'queued',
      failures: 0,
      crashes: 0,
      deferrals: 0,
      deferred_ms: '0',
      replays: 0,
    });
  });

  it('is unique per (organization, idempotency_key) but not across organizations', async () => {
    await expectPgError(insert(), '23505', 'job_ledger_organization_id_idempotency_key_key');
    await expect(
      insert({
        organization_id: other.organizationId,
        brand_id: other.brandId,
        connection_id: other.connectionId,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a connection from another tenant scope', async () => {
    await expectPgError(
      insert({ idempotency_key: 'b'.repeat(64), connection_id: other.connectionId }),
      '23503',
      'job_ledger_organization_id_brand_id_connection_id_fkey',
    );
  });

  it.each([
    ['job_ledger_platform_check', { platform: 'myspace' }],
    ['job_ledger_job_type_check', { job_type: 'Hide Comment' }],
    ['job_ledger_idempotency_key_check', { idempotency_key: 'not-hex' }],
    ['job_ledger_payload_check', { payload: '[1,2]' }],
    ['job_ledger_payload_check', { payload: JSON.stringify({ x: 'y'.repeat(70_000) }) }],
    ['job_ledger_state_check', { state: 'running' }],
    ['job_ledger_lease_check', { lease_owner: 'w1' }],
    ['job_ledger_dead_letter_check', { state: 'dead_lettered' }],
    ['job_ledger_completed_check', { state: 'completed' }],
    [
      'job_ledger_last_error_code_check',
      { last_error_kind: 'retryable', last_error_code: 'Bad Code!' },
    ],
  ])('enforces %s', async (constraint, over) => {
    await expectPgError(insert({ idempotency_key: 'c'.repeat(64), ...over }), '23514', constraint);
  });

  it('cascades when the connection is deleted', async () => {
    const tmp = await seedTenant(db.c, 'jl-c');
    await insert({
      organization_id: tmp.organizationId,
      brand_id: tmp.brandId,
      connection_id: tmp.connectionId,
      idempotency_key: 'd'.repeat(64),
    });
    await db.c.query('DELETE FROM connection WHERE id = $1', [tmp.connectionId]);
    const r = await db.c.query(
      'SELECT count(*)::int AS n FROM job_ledger WHERE connection_id = $1',
      [tmp.connectionId],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('bumps updated_at on update', async () => {
    const { rows } = await insert({ idempotency_key: 'e'.repeat(64) });
    const read = async () =>
      (await db.c.query('SELECT updated_at FROM job_ledger WHERE id = $1', [rows[0].id])).rows[0]
        .updated_at as Date;
    const before = await read();
    await new Promise((r) => setTimeout(r, 10));
    await db.c.query('UPDATE job_ledger SET failures = 1 WHERE id = $1', [rows[0].id]);
    const after = await read();
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
