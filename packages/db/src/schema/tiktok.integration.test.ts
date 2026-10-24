import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, type Tenant } from '../testing/index.js';

let pool: pg.Client;
let close: () => Promise<void>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ({ c: pool, close } = await migratedDb());
  a = await seedTenant(pool, 'tta');
  b = await seedTenant(pool, 'ttb');
});
afterAll(() => close());
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; constraint?: string }) => e.constraint ?? e.code,
  );
let n = 0;
const uniq = () => `${Date.now()}${++n}`;
const conn = async (t: Tenant, platform: string, acct = uniq()) =>
  (
    await pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
   VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [t.organizationId, t.brandId, platform, acct],
    )
  ).rows[0]!.id;

describe('tiktok schema', () => {
  it('accepts tiktok_ads in every platform check', async () => {
    expect(await code(conn(a, 'tiktok_ads'))).toBe('ok');
    const envelope = () => Buffer.concat([Buffer.from([1]), randomBytes(63)]);
    expect(
      await code(
        pool.query(
          `INSERT INTO oauth_state (organization_id, brand_id, platform, initiated_by_user_id, state_hash,
             encrypted_pkce_verifier, redirect_uri, expires_at)
           VALUES ($1,$2,'tiktok_ads',$3,$4,$5,'https://app.test/cb', now() + interval '10 minutes')`,
          [a.organizationId, a.brandId, a.userId, randomBytes(32), envelope()],
        ),
      ),
    ).toBe('ok');
    expect(
      await code(
        pool.query(
          `INSERT INTO oauth_grant (organization_id, brand_id, platform, initiated_by_user_id,
             encrypted_user_token, expires_at)
           VALUES ($1,$2,'tiktok_ads',$3,$4, now() + interval '10 minutes')`,
          [a.organizationId, a.brandId, a.userId, envelope()],
        ),
      ),
    ).toBe('ok');
    expect(
      await code(
        pool.query(
          `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type,
             idempotency_key, payload, expires_at)
           VALUES ($1,$2,$3,'tiktok_ads','hide_comment',$4,'{}', now() + interval '1 day')`,
          [a.organizationId, a.brandId, a.connectionId, 'b'.repeat(64)],
        ),
      ),
    ).toBe('ok');
  });

  it('connection_poll: one row per connection, kind checked, cascades with the connection', async () => {
    const c = await conn(a, 'tiktok_ads');
    const ins = (kind = 'tiktok_ad_comments') =>
      pool.query(
        `INSERT INTO connection_poll (connection_id, organization_id, brand_id, kind) VALUES ($1,$2,$3,$4)`,
        [c, a.organizationId, a.brandId, kind],
      );
    await ins();
    expect(await code(ins())).toBe('connection_poll_pkey');
    expect(
      await code(pool.query(`UPDATE connection_poll SET kind = 'x' WHERE connection_id = $1`, [c])),
    ).toBe('connection_poll_kind_check');
    expect(
      await code(
        pool.query(`UPDATE connection_poll SET resume_page = 1 WHERE connection_id = $1`, [c]),
      ),
    ).toBe('connection_poll_resume_page_check');
    await pool.query(`DELETE FROM connection WHERE id = $1`, [c]);
    expect(
      (await pool.query(`SELECT 1 FROM connection_poll WHERE connection_id = $1`, [c])).rowCount,
    ).toBe(0);
  });

  it('connection_poll rejects a cross-tenant connection', async () => {
    const cb = await conn(b, 'tiktok');
    expect(
      await code(
        pool.query(
          `INSERT INTO connection_poll (connection_id, organization_id, brand_id, kind) VALUES ($1,$2,$3,'tiktok_videos')`,
          [cb, a.organizationId, a.brandId],
        ),
      ),
    ).toMatch(/fkey/);
  });

  it('rules default to applies_to all and reject other values', async () => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO rule (organization_id, brand_id, name, conditions, action)
         VALUES ($1,$2,'r','{}'::jsonb,'hide') RETURNING id`,
        [a.organizationId, a.brandId],
      )
    ).rows[0]!.id;
    const get = async () =>
      (await pool.query(`SELECT applies_to FROM rule WHERE id = $1`, [id])).rows[0].applies_to;
    expect(await get()).toBe('all');
    expect(await code(pool.query(`UPDATE rule SET applies_to = 'paid' WHERE id = $1`, [id]))).toBe(
      'rule_applies_to_check',
    );
    await pool.query(`UPDATE rule SET applies_to = 'ad' WHERE id = $1`, [id]);
    expect(await get()).toBe('ad');
  });

  it('missing_scopes defaults to empty and is bounded', async () => {
    const c = await conn(a, 'tiktok');
    const get = async () =>
      (await pool.query(`SELECT missing_scopes FROM connection WHERE id = $1`, [c])).rows[0]
        .missing_scopes;
    expect(await get()).toEqual([]);
    const set = (k: number) =>
      pool.query(`UPDATE connection SET missing_scopes = $2::text[] WHERE id = $1`, [
        c,
        Array.from({ length: k }, (_, i) => `s${i}`),
      ]);
    expect(await code(set(20))).toBe('ok');
    expect(await code(set(21))).toBe('connection_missing_scopes_check');
  });

  it('oauth_scope_missing is an allowed status_reason', async () => {
    const c = await conn(a, 'tiktok');
    expect(
      await code(
        pool.query(
          `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_scope_missing' WHERE id = $1`,
          [c],
        ),
      ),
    ).toBe('ok');
  });
});
