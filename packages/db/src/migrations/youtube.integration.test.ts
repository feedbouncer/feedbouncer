import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid, type Tenant } from '../testing/index.js';
import { expectPgError } from '../testing/pg-error.js';
import { DEFAULT_MIGRATIONS_DIR } from './cli.js';
import { rollbackLatest } from './rollback.js';

const MIGRATION = '20261025000100_youtube';
const TABLES = [
  'youtube_connection_settings',
  'youtube_connection_state',
  'youtube_thread',
  'youtube_action_queue',
  'youtube_write_batch',
  'youtube_quota_ledger',
  'youtube_quota_pause',
  'youtube_notice',
];

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
let t: Tenant;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
  t = await seedTenant(c, 'yt');
});
afterAll(() => ctx.close());

const scope = (x: Tenant) => [x.organizationId, x.brandId, x.connectionId];
const newConnection = async (x: Tenant) =>
  (
    await c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1,$2,'youtube',$3,'active') RETURNING id`,
      [x.organizationId, x.brandId, `UC${uuid().replaceAll('-', '').slice(0, 22)}`],
    )
  ).rows[0]!.id;
const existing = async () =>
  (
    await c.query<{ t: string | null }>(`SELECT to_regclass(x) AS t FROM unnest($1::text[]) AS x`, [
      TABLES,
    ])
  ).rows.map((r) => r.t !== null);

const batch = (over: { ban?: boolean; status?: string; ids?: string[] } = {}) =>
  c.query(
    `INSERT INTO youtube_write_batch (id, organization_id, brand_id, connection_id, pacific_day,
       moderation_status, ban_author, comment_external_ids, action_ids, state)
     VALUES ($1,$2,$3,$4,'2026-10-25',$5,$6,$7::text[],$8::uuid[],'planned')`,
    [
      uuid(),
      ...scope(t),
      over.status ?? 'rejected',
      over.ban ?? false,
      over.ids ?? ['Ugx1234567890'],
      [uuid()],
    ],
  );

const ledger = (key: string, connectionId: string | null) =>
  c.query(
    `INSERT INTO youtube_quota_ledger (id, call_key, pacific_day, organization_id, brand_id, connection_id,
       method, purpose, units)
     VALUES ($1,$2,'2026-10-25',$3,$4,$5,'commentThreads.list','read',1)`,
    [uuid(), key, t.organizationId, t.brandId, connectionId],
  );

describe('youtube migration', () => {
  it('creates every table', async () => {
    expect(await existing()).toEqual(TABLES.map(() => true));
  });

  it('settings: defaults, protected author ids validated, updated_at trigger', async () => {
    const id = await newConnection(t);
    await c.query(
      `INSERT INTO youtube_connection_settings (connection_id, organization_id, brand_id) VALUES ($1,$2,$3)`,
      [id, t.organizationId, t.brandId],
    );
    const row = (
      await c.query(`SELECT * FROM youtube_connection_settings WHERE connection_id = $1`, [id])
    ).rows[0];
    expect(row).toMatchObject({
      daily_budget_units: 2000,
      dry_run: false,
      protected_author_ids: [],
    });
    const set = (ids: (string | null)[]) =>
      c.query(
        `UPDATE youtube_connection_settings SET protected_author_ids = $2::text[] WHERE connection_id = $1`,
        [id, ids],
      );
    const uc = 'UC' + 'a'.repeat(22);
    await expectPgError(set(['x']), '23514');
    // A single element that merely looks like two joined ids must not pass.
    await expectPgError(set([`${uc},${uc}`]), '23514');
    await expectPgError(set(['']), '23514');
    await expectPgError(set([null]), '23514');
    await expectPgError(set([uc, null]), '23514');
    await expectPgError(set([uc, 'x']), '23514');
    await expectPgError(set(['UC' + 'a'.repeat(21)]), '23514');
    await set(['UC' + 'a'.repeat(22), 'UC' + 'A_-'.repeat(7) + 'z']);
    await expectPgError(set(Array.from({ length: 201 }, () => 'UC' + 'a'.repeat(22))), '23514');
    const budget = (n: number) =>
      c.query(
        `UPDATE youtube_connection_settings SET daily_budget_units = $2 WHERE connection_id = $1`,
        [id, n],
      );
    await expectPgError(budget(-1), '23514');
    await expectPgError(budget(1_000_001), '23514');
    await budget(0);
    const after = (
      await c.query(
        `SELECT updated_at > created_at AS bumped FROM youtube_connection_settings WHERE connection_id = $1`,
        [id],
      )
    ).rows[0];
    expect(after.bumped).toBe(true);
  });

  it('state: defaults and format checks', async () => {
    const id = await newConnection(t);
    await c.query(
      `INSERT INTO youtube_connection_state (connection_id, organization_id, brand_id) VALUES ($1,$2,$3)`,
      [id, t.organizationId, t.brandId],
    );
    const row = (
      await c.query(
        `SELECT last_read_units, next_read_at IS NOT NULL AS has_next FROM youtube_connection_state WHERE connection_id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ last_read_units: 2, has_next: true });
    const upd = (col: string, v: string) =>
      c.query(`UPDATE youtube_connection_state SET ${col} = $2 WHERE connection_id = $1`, [id, v]);
    await expectPgError(upd('resume_page_token', 'a?b'), '23514');
    await upd('resume_page_token', 'CAUQAA_-');
    await upd('resume_page_token', 'a'.repeat(512));
    await expectPgError(upd('resume_page_token', 'a'.repeat(513)), '23514');
    await expectPgError(upd('last_error_code', 'Bad Code'), '23514');
    await upd('last_error_code', 'quota_exceeded');
  });

  it('write batch: ban requires rejected, at most 50 comments', async () => {
    await batch();
    await batch({ ban: true, status: 'rejected' });
    await expectPgError(batch({ ban: true, status: 'heldForReview' }), '23514');
    await expectPgError(
      batch({ ids: Array.from({ length: 51 }, (_, i) => `Ugx${i}abcdefghij`) }),
      '23514',
    );
    await expectPgError(batch({ ids: [] }), '23514');
    await expectPgError(batch({ status: 'deleted' }), '23514');
  });

  it('quota ledger: unique call_key', async () => {
    await ledger('k-dup', t.connectionId);
    await expectPgError(ledger('k-dup', t.connectionId), '23505');
  });

  it('quota pause and notice: checks', async () => {
    await c.query(
      `INSERT INTO youtube_quota_pause (pacific_day, reason, resume_at) VALUES ('2026-10-25','quota_exceeded', now())`,
    );
    await expectPgError(
      c.query(
        `INSERT INTO youtube_quota_pause (pacific_day, reason, resume_at) VALUES ('2026-10-26','other', now())`,
      ),
      '23514',
    );
    const notice = (kind: string) =>
      c.query(
        `INSERT INTO youtube_notice (connection_id, kind, pacific_day, organization_id, brand_id) VALUES ($1,$2,'2026-10-25',$3,$4)`,
        [t.connectionId, kind, t.organizationId, t.brandId],
      );
    await notice('quota_paused');
    await expectPgError(notice('quota_paused'), '23505');
    await expectPgError(notice('bogus'), '23514');
  });

  const seedAction = async (x: Tenant) => {
    const comment = (
      await c.query<{ id: string }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at)
         VALUES ($1,$2,$3,$4,$5,'text', now()) RETURNING id`,
        [...scope(x), x.sourceId, `c-${uuid()}`],
      )
    ).rows[0]!.id;
    const action = (
      await c.query<{ id: string }>(
        `INSERT INTO moderation_action (organization_id, brand_id, connection_id, comment_id, kind, actor_type, request_key)
         VALUES ($1,$2,$3,$4,'hide','system',$5) RETURNING id`,
        [...scope(x), comment, `rk-${uuid()}`],
      )
    ).rows[0]!.id;
    return { comment, action };
  };
  const enqueue = (x: Tenant, action: string, comment: string) =>
    c.query(
      `INSERT INTO youtube_action_queue (action_id, organization_id, brand_id, connection_id, comment_id, tier, requested_at)
       VALUES ($1,$2,$3,$4,$5,2,now())`,
      [action, ...scope(x), comment],
    );

  it('thread rows reject another tenant connection', async () => {
    const other = await seedTenant(c, 'yt-other-thread');
    await expectPgError(
      c.query(
        `INSERT INTO youtube_thread (connection_id, thread_external_id, organization_id, brand_id, video_external_id, reply_count, last_activity_at)
         VALUES ($1,'Ugx1234567890',$2,$3,'abcdefghijk',0,now())`,
        [other.connectionId, t.organizationId, t.brandId],
      ),
      '23503',
    );
  });

  it('queue rows reject another tenant connection, action or comment', async () => {
    const a = await seedTenant(c, 'yt-q-a');
    const b = await seedTenant(c, 'yt-q-b');
    const own = await seedAction(a);
    const foreign = await seedAction(b);
    // Brand A's connection with brand B's action.
    await expectPgError(enqueue(a, foreign.action, own.comment), '23503');
    // Brand A's connection with brand B's comment.
    await expectPgError(enqueue(a, own.action, foreign.comment), '23503');
    // Brand B's scope columns with brand A's connection.
    await expectPgError(
      c.query(
        `INSERT INTO youtube_action_queue (action_id, organization_id, brand_id, connection_id, comment_id, tier, requested_at)
         VALUES ($1,$2,$3,$4,$5,2,now())`,
        [foreign.action, b.organizationId, b.brandId, a.connectionId, foreign.comment],
      ),
      '23503',
    );
    await enqueue(a, own.action, own.comment);
    // Deleting the comment or the action removes the queue row.
    await c.query('DELETE FROM moderation_action WHERE id = $1', [own.action]);
    expect(
      (await c.query('SELECT 1 FROM youtube_action_queue WHERE action_id = $1', [own.action]))
        .rowCount,
    ).toBe(0);
    const again = await seedAction(a);
    await enqueue(a, again.action, again.comment);
    await c.query('DELETE FROM comment WHERE id = $1', [again.comment]);
    expect(
      (await c.query('SELECT 1 FROM youtube_action_queue WHERE action_id = $1', [again.action]))
        .rowCount,
    ).toBe(0);
  });

  it('deleting a connection cascades queue and settings but keeps ledger rows detached', async () => {
    const x = await seedTenant(c, 'yt-casc');
    await c.query(
      `INSERT INTO youtube_connection_settings (connection_id, organization_id, brand_id) VALUES ($1,$2,$3)`,
      [x.connectionId, x.organizationId, x.brandId],
    );
    const { comment, action } = await seedAction(x);
    await enqueue(x, action, comment);
    await expectPgError(
      c.query(`UPDATE youtube_action_queue SET tier = 4 WHERE action_id = $1`, [action]),
      '23514',
    );
    await expectPgError(
      c.query(`UPDATE youtube_action_queue SET state = 'done' WHERE action_id = $1`, [action]),
      '23514',
    );
    await ledger('k-casc', x.connectionId);
    await c.query('DELETE FROM connection WHERE id = $1', [x.connectionId]);
    const n = async (sql: string) =>
      Number((await c.query<{ n: string }>(sql, [x.connectionId])).rows[0]!.n);
    expect(await n('SELECT count(*) AS n FROM youtube_action_queue WHERE connection_id = $1')).toBe(
      0,
    );
    expect(
      await n('SELECT count(*) AS n FROM youtube_connection_settings WHERE connection_id = $1'),
    ).toBe(0);
    const kept = await c.query(
      `SELECT connection_id FROM youtube_quota_ledger WHERE call_key = 'k-casc'`,
    );
    expect(kept.rows).toEqual([{ connection_id: null }]);
  });

  it('down.sql removes every table and re-applying round-trips', async () => {
    expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
      status: 'rolled_back',
      migration: '20261026000100_threads',
    });
    expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
      status: 'rolled_back',
      migration: MIGRATION,
    });
    expect(await existing()).toEqual(TABLES.map(() => false));
    const sql = await readFile(
      path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION, 'migration.sql'),
      'utf8',
    );
    await c.query(sql);
    expect(await existing()).toEqual(TABLES.map(() => true));
  });
});
