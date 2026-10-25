import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/index.js';
import { expectPgError as expectPg } from '../testing/pg-error.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { rollbackLatest } from '../migrations/rollback.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION = '20261026000100_threads';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
let t: Tenant;
let other: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
  t = await seedTenant(c, 'thr');
  other = await seedTenant(c, 'thr2');
});
afterAll(() => ctx.close());

const connection = async (account: string, status = 'active', x: Tenant = t) =>
  (
    await c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1,$2,'threads',$3,$4) RETURNING id`,
      [x.organizationId, x.brandId, account, status],
    )
  ).rows[0]!.id;
const pending = (conn: string, id: string, source = '17900000000000001') =>
  c.query(
    `INSERT INTO threads_pending_reply (organization_id, brand_id, connection_id, external_id, source_external_id, received_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [t.organizationId, t.brandId, conn, id, source],
  );
const hasColumns = async () =>
  (
    await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
       WHERE (table_name = 'source_poll' AND column_name = 'owner_verified')
          OR (table_name = 'moderation_action' AND column_name IN ('deferred_until','deferred_code'))`,
    )
  ).rows[0]!.n;

describe('threads schema', () => {
  it('two live threads connections for one account are rejected; a revoked one is not counted', async () => {
    const account = `th-${uuid()}`;
    const first = await connection(account);
    await expectPg(
      connection(account, 'active', other),
      '23505',
      'connection_threads_live_account_key',
    );
    await c.query(`UPDATE connection SET status = 'revoked' WHERE id = $1`, [first]);
    await connection(account, 'active', other);
  });

  it('pending reply rejects a non-numeric id', async () => {
    const conn = await connection(`th-${uuid()}`);
    await expectPg(pending(conn, 'abc'), '23514', 'threads_pending_reply_external_id_check');
    await expectPg(
      pending(conn, '1', 'x1'),
      '23514',
      'threads_pending_reply_source_external_id_check',
    );
    await pending(conn, '123');
    await expectPg(pending(conn, '123'), '23505', 'threads_pending_reply_pkey');
  });

  it('pending rows cascade with the connection', async () => {
    const conn = await connection(`th-${uuid()}`);
    await pending(conn, '555');
    await c.query(`DELETE FROM connection WHERE id = $1`, [conn]);
    const left = await c.query(`SELECT 1 FROM threads_pending_reply WHERE connection_id = $1`, [
      conn,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('source_poll.owner_verified is nullable (null unchecked, false foreign)', async () => {
    const row = await c.query<{ owner_verified: boolean | null }>(
      `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id)
       VALUES ($1,$2,$3,$4) RETURNING owner_verified`,
      [t.sourceId, t.organizationId, t.brandId, t.connectionId],
    );
    expect(row.rows[0]!.owner_verified).toBeNull();
    await c.query(`UPDATE source_poll SET owner_verified = false WHERE source_id = $1`, [
      t.sourceId,
    ]);
  });

  it('deferred_until without deferred_code is rejected', async () => {
    const comment = (
      await c.query<{ id: string }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
         VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, t.sourceId, `c-${uuid()}`],
      )
    ).rows[0]!.id;
    const action = (
      await c.query<{ id: string }>(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, request_key)
         VALUES ($1,$2,$3,$4,'hide','system',$5) RETURNING id`,
        [t.organizationId, t.brandId, t.connectionId, comment, `rk-${uuid()}`],
      )
    ).rows[0]!.id;
    const set = (until: string | null, code: string | null) =>
      c.query(
        `UPDATE moderation_action SET deferred_until = $2, deferred_code = $3 WHERE id = $1`,
        [action, until, code],
      );
    await expectPg(set('2030-01-01T00:00:00Z', null), '23514', 'moderation_action_deferred_check');
    await expectPg(set(null, 'rate_limited'), '23514', 'moderation_action_deferred_check');
    await expectPg(
      set('2030-01-01T00:00:00Z', 'Bad Code'),
      '23514',
      'moderation_action_deferred_code_check',
    );
    await set('2030-01-01T00:00:00Z', 'rate_limited');
    await set(null, null);
  });

  it('connection_poll accepts threads_posts', async () => {
    const conn = await connection(`th-${uuid()}`);
    await c.query(
      `INSERT INTO connection_poll (connection_id, organization_id, brand_id, kind) VALUES ($1,$2,$3,'threads_posts')`,
      [conn, t.organizationId, t.brandId],
    );
    await expectPg(
      c.query(`UPDATE connection_poll SET kind = 'other' WHERE connection_id = $1`, [conn]),
      '23514',
      'connection_poll_kind_check',
    );
  });

  it('down then up round-trips', async () => {
    expect(await hasColumns()).toBe('3');
    expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
      status: 'rolled_back',
      migration: MIGRATION,
    });
    expect(await hasColumns()).toBe('0');
    expect(
      (await c.query<{ t: string | null }>(`SELECT to_regclass('threads_pending_reply') AS t`))
        .rows[0]!.t,
    ).toBeNull();
    const sql = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION, 'migration.sql'),
      'utf8',
    );
    await c.query(sql);
    expect(await hasColumns()).toBe('3');
  });
});
