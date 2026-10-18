import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, uuid } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261017000300_weekly_report';
const TABLES = ['report_subscription', 'weekly_report', 'weekly_report_delivery'];

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0]!.id;
const count = async (table: string, where: string, v: unknown[]) =>
  Number(
    (await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, v)).rows[0]!
      .n,
  );

const subscription = (orgId: string, userId: string) =>
  id(
    `INSERT INTO report_subscription (organization_id, user_id, key_id, unsubscribe_key_sha256, encrypted_unsubscribe_token)
     VALUES ($1, $2, 'k1', $3, $4) RETURNING id`,
    [orgId, userId, Buffer.from(uuid()), Buffer.from('sealed')],
  );
const report = (orgId: string, weekStart = '2026-10-05', status = 'queued', payload = '{}') =>
  id(
    `INSERT INTO weekly_report (organization_id, week_start, timezone, period_start, period_end, status, payload, computed_at)
     VALUES ($1, $2::date, 'UTC', $2::date, $2::date + 7, $3, $4::jsonb, now()) RETURNING id`,
    [orgId, weekStart, status, status === 'queued' ? payload : null],
  );
const delivery = (orgId: string, reportId: string, userId: string, over = '') =>
  id(
    `INSERT INTO weekly_report_delivery (organization_id, report_id, user_id${over ? ', last_error_code' : ''})
     VALUES ($1, $2, $3${over ? ', $4' : ''}) RETURNING id`,
    [orgId, reportId, userId, ...(over ? [over] : [])],
  );

describe('organization.timezone', () => {
  it('defaults to UTC and is backfilled from the oldest set brand timezone; archived and unset brands ignored', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        for (const m of dirs.slice(dirs.indexOf(MIGRATION)).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: m,
          });
        const brand = (orgId: string, tz: string | null, at: string, archived = false) =>
          k.query(
            `INSERT INTO brand (organization_id, name, timezone, timezone_set_at, created_at, archived_at)
             VALUES ($1, $2, COALESCE($3, 'UTC'), CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, $4,
                     CASE WHEN $5 THEN now() END)`,
            [orgId, `B-${uuid()}`, tz, at, archived],
          );
        const org = async (label: string) => (await seedTenant(k, label)).organizationId;
        const picked = await org('bf-picked');
        await k.query('DELETE FROM brand WHERE organization_id = $1', [picked]);
        await brand(picked, null, '2026-01-01');
        await brand(picked, 'Asia/Tokyo', '2026-01-02', true);
        await brand(picked, 'Europe/Paris', '2026-01-03');
        await brand(picked, 'America/New_York', '2026-01-04');
        const unset = await org('bf-unset');
        const lonely = await org('bf-lonely');
        await k.query('DELETE FROM brand WHERE organization_id = $1', [lonely]);

        const sql = await (
          await import('node:fs/promises')
        ).readFile(`${DEFAULT_MIGRATIONS_DIR}/${MIGRATION}/migration.sql`, 'utf8');
        await k.query(sql);

        const row = async (orgId: string) =>
          (
            await k.query<{ timezone: string; set: boolean }>(
              'SELECT timezone, timezone_set_at IS NOT NULL AS set FROM organization WHERE id = $1',
              [orgId],
            )
          ).rows[0]!;
        expect(await row(picked)).toEqual({ timezone: 'Europe/Paris', set: true });
        expect(await row(unset)).toEqual({ timezone: 'UTC', set: false });
        expect(await row(lonely)).toEqual({ timezone: 'UTC', set: false });
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });

  it("rejects 'Bad Zone!'", async () => {
    const t = await seedTenant(c, 'tz');
    await expectPgError(
      c.query("UPDATE organization SET timezone = 'Bad Zone!' WHERE id = $1", [t.organizationId]),
      '23514',
    );
    await c.query("UPDATE organization SET timezone = 'Europe/Paris' WHERE id = $1", [
      t.organizationId,
    ]);
  });
});

describe('report_subscription', () => {
  it('requires an existing membership (23503) and is deleted when the membership row is deleted', async () => {
    const a = await seedTenant(c, 'sub-a');
    const b = await seedTenant(c, 'sub-b');
    await expectPgError(subscription(a.organizationId, b.userId), '23503');
    await subscription(a.organizationId, a.userId);
    expect(await count('report_subscription', 'organization_id = $1', [a.organizationId])).toBe(1);
    await c.query('DELETE FROM organization WHERE id = $1', [a.organizationId]);
    expect(await count('report_subscription', 'organization_id = $1', [a.organizationId])).toBe(0);

    const m = await seedTenant(c, 'sub-m');
    const other = await id('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
      `o-${uuid()}@example.test`,
    ]);
    await c.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
      [m.organizationId, other],
    );
    await subscription(m.organizationId, other);
    await c.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      m.organizationId,
      other,
    ]);
    expect(await count('report_subscription', 'user_id = $1', [other])).toBe(0);
  });

  it('subscription unique per (org, user); status and unsubscribed_at agree', async () => {
    const t = await seedTenant(c, 'sub-u');
    await subscription(t.organizationId, t.userId);
    await expectPgError(subscription(t.organizationId, t.userId), '23505');
    const set = (status: string, at: string) =>
      c.query(
        'UPDATE report_subscription SET status = $3, unsubscribed_at = $4 WHERE organization_id = $1 AND user_id = $2',
        [t.organizationId, t.userId, status, at === 'now' ? new Date() : null],
      );
    await expectPgError(set('unsubscribed', 'null'), '23514');
    await expectPgError(set('subscribed', 'now'), '23514');
    await expectPgError(set('paused', 'null'), '23514');
    await set('unsubscribed', 'now');
  });
});

describe('weekly_report', () => {
  it('unique per (org, week_start); week_start must be a Monday; queued requires payload', async () => {
    const t = await seedTenant(c, 'wr');
    await report(t.organizationId);
    await expectPgError(report(t.organizationId), '23505');
    await expectPgError(report(t.organizationId, '2026-10-06'), '23514');
    await expectPgError(report(t.organizationId, '2026-10-12', 'queued', '[]'), '23514');
    await report(t.organizationId, '2026-10-12', 'skipped_quiet');
    await expectPgError(
      c.query(
        `INSERT INTO weekly_report (organization_id, week_start, timezone, period_start, period_end, status, payload, computed_at)
         VALUES ($1, '2026-10-19', 'UTC', now(), now(), 'missed', NULL, now())`,
        [t.organizationId],
      ),
      '23514',
    );
    await expectPgError(
      c.query(
        `INSERT INTO weekly_report (organization_id, week_start, timezone, period_start, period_end, status, payload, computed_at)
         VALUES ($1, '2026-10-19', 'UTC', now(), now() + interval '1 day', 'skipped_quiet', '{}', now())`,
        [t.organizationId],
      ),
      '23514',
    );
  });
});

describe('weekly_report_delivery', () => {
  it('unique per (report, user); org-B report id with org-A organization_id is rejected', async () => {
    const a = await seedTenant(c, 'del-a');
    const b = await seedTenant(c, 'del-b');
    const rA = await report(a.organizationId);
    const rB = await report(b.organizationId);
    await delivery(a.organizationId, rA, a.userId);
    await expectPgError(delivery(a.organizationId, rA, a.userId), '23505');
    await expectPgError(delivery(a.organizationId, rB, a.userId), '23503');
    await c.query('DELETE FROM weekly_report WHERE id = $1', [rA]);
    expect(await count('weekly_report_delivery', 'report_id = $1', [rA])).toBe(0);
  });

  it('requires an existing membership of the report org (23503); removing the membership deletes the delivery', async () => {
    const a = await seedTenant(c, 'del-m-a');
    const b = await seedTenant(c, 'del-m-b');
    const r = await report(a.organizationId);
    await expectPgError(delivery(a.organizationId, r, b.userId), '23503');
    const member = await id('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
      `d-${uuid()}@example.test`,
    ]);
    await c.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
      [a.organizationId, member],
    );
    await delivery(a.organizationId, r, member);
    expect(await count('weekly_report_delivery', 'user_id = $1', [member])).toBe(1);
    await c.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      a.organizationId,
      member,
    ]);
    expect(await count('weekly_report_delivery', 'user_id = $1', [member])).toBe(0);
  });

  it("last_error_code rejects 'Bad Code!'", async () => {
    const t = await seedTenant(c, 'del-code');
    const r = await report(t.organizationId);
    await expectPgError(delivery(t.organizationId, r, t.userId, 'Bad Code!'), '23514');
    await delivery(t.organizationId, r, t.userId, 'smtp_550');
  });
});

describe('conventions', () => {
  it('suite passes (encrypted_* plus FK indexes)', async () => {
    const cols = (
      await c.query<{ col: string }>(
        `SELECT attname AS col FROM pg_attribute WHERE attrelid = 'report_subscription'::regclass AND attnum > 0`,
      )
    ).rows.map((r) => r.col);
    expect(cols).toContain('encrypted_unsubscribe_token');
    const unindexed = await c.query(
      `SELECT k.conname FROM pg_constraint k
        WHERE k.contype = 'f' AND k.conrelid = ANY($1::regclass[])
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = k.conrelid
                           AND i.indkey[0] = k.conkey[array_length(k.conkey, 1)])`,
      [TABLES],
    );
    expect(unindexed.rows).toEqual([]);
  });
});

describe('down.sql', () => {
  it('reverts cleanly', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const applied = await snapshotSchema(k);
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        for (const later of dirs.slice(dirs.indexOf(MIGRATION) + 1).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: later,
          });
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        for (const table of TABLES) expect(down).not.toMatch(new RegExp(`\\b${table}\\.`));
        expect(down).not.toMatch(/organization\.timezone/);
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        expect(await snapshotSchema(k)).toEqual(applied);
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });
});
