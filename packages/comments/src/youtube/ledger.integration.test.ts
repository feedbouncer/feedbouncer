import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { ConnectorError, type Clock, type QuotaMeter } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { LEDGER_RETENTION_DAYS, PgYouTubeQuotaLedger, type QuotaLedgerLog } from './ledger.js';
import { PgYouTubeSettings } from './settings.js';
import { nextPacificMidnight, pacificDayKey } from './quota-day.js';

// 2026-10-24 05:00 Pacific (PDT).
const START_MS = Date.parse('2026-10-24T12:00:00Z');

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let t = START_MS;
const clock: Clock = { now: () => t };
let logged: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
const log: QuotaLedgerLog = {
  warn: (msg, fields) => void logged.push({ level: 'warn', msg, ...(fields && { fields }) }),
  error: (msg, fields) => void logged.push({ level: 'error', msg, ...(fields && { fields }) }),
};
let settings: PgYouTubeSettings;

const ledger = (o: { projectQuota?: number; projectHeadroom?: number; pool?: pg.Pool } = {}) =>
  new PgYouTubeQuotaLedger({
    pool: o.pool ?? pool,
    clock,
    projectQuota: o.projectQuota ?? 10_000,
    projectHeadroom: o.projectHeadroom ?? 1000,
    settings,
    log,
  });

const youtubeConnection = async (label: string): Promise<ConnectionScope> => {
  const a = await seedTenant(db.c, `yt-ledger-${label}`);
  const ext = `UC${randomUUID().replaceAll('-', '').slice(0, 22)}`;
  const r = await db.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'youtube', $3) RETURNING id`,
    [a.organizationId, a.brandId, ext],
  );
  return { organizationId: a.organizationId, brandId: a.brandId, connectionId: r.rows[0]!.id };
};

const read = { method: 'commentThreads.list', units: 1, purpose: 'read' } as const;
const write = { method: 'comments.setModerationStatus', units: 50, purpose: 'write' } as const;

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectorError);
  return err as ConnectorError;
};

const rows = async (scope: ConnectionScope) =>
  (
    await pool.query<{
      outcome: string;
      units: number;
      simulated: boolean;
      error_code: string | null;
    }>(
      `SELECT outcome, units, simulated, error_code FROM youtube_quota_ledger
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 ORDER BY created_at, id`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    )
  ).rows;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'yt-ledger', onIdleError: () => {} });
  settings = new PgYouTubeSettings(pool);
});
afterAll(async () => {
  await pool.end();
  await db.close();
});
beforeEach(async () => {
  // Each test owns the whole project: the project cap and the pause are deployment-wide.
  await pool.query('DELETE FROM youtube_quota_ledger');
  await pool.query('DELETE FROM youtube_quota_pause');
  t = START_MS;
  logged = [];
});

describe('PgYouTubeSettings', () => {
  it('returns defaults for a missing row and upserts patches', async () => {
    const s = await youtubeConnection('settings');
    expect(await settings.get(s)).toEqual({
      dailyBudgetUnits: 2000,
      dryRun: false,
      protectedAuthorIds: [],
    });
    const a = await seedTenant(db.c, 'yt-ledger-settings-user');
    const updated = await settings.update(s, { dailyBudgetUnits: 500 }, a.userId);
    expect(updated).toEqual({ dailyBudgetUnits: 500, dryRun: false, protectedAuthorIds: [] });
    const id = `UC${'a'.repeat(22)}`;
    expect(await settings.update(s, { dryRun: true, protectedAuthorIds: [id] }, a.userId)).toEqual({
      dailyBudgetUnits: 500,
      dryRun: true,
      protectedAuthorIds: [id],
    });
    expect(await settings.get(s)).toEqual({
      dailyBudgetUnits: 500,
      dryRun: true,
      protectedAuthorIds: [id],
    });
  });

  it("another tenant's scope neither reads nor writes the row", async () => {
    const s = await youtubeConnection('settings-a');
    const other = await youtubeConnection('settings-b');
    const a = await seedTenant(db.c, 'yt-ledger-settings-a-user');
    await settings.update(s, { dailyBudgetUnits: 700 }, a.userId);
    const foreign = { ...other, connectionId: s.connectionId };
    expect((await settings.get(foreign)).dailyBudgetUnits).toBe(2000);
    await expect(settings.update(foreign, { dailyBudgetUnits: 1 }, a.userId)).rejects.toThrow();
    expect((await settings.get(s)).dailyBudgetUnits).toBe(700);
  });
});

describe('PgYouTubeQuotaLedger', () => {
  it('totals survive a new ledger instance (restart)', async () => {
    const s = await youtubeConnection('restart');
    const m = ledger().meterFor(s);
    for (let i = 0; i < 3; i++) await m.reserve(read);
    const u = await ledger().usage(s);
    expect(u.spentUnits).toBe(3);
    expect(u.readsSpentUnits).toBe(3);
    expect(u.projectSpentUnits).toBe(3);
    expect(u.projectCapUnits).toBe(9000);
    expect(u.budgetUnits).toBe(2000);
    expect(u.paused).toBe(false);
    expect(u.msUntilReset).toBe(nextPacificMidnight(t).getTime() - t);
    expect((await rows(s)).map((r) => r.outcome)).toEqual(['sent', 'sent', 'sent']);
  });

  it('settle is idempotent', async () => {
    const s = await youtubeConnection('idempotent');
    const m = ledger().meterFor(s);
    const ticket = await m.reserve(write);
    await m.settle(ticket, { ok: true });
    await m.settle(ticket, { ok: false, errorCode: 'not_found' });
    expect(await rows(s)).toEqual([
      { outcome: 'ok', units: 50, simulated: false, error_code: null },
    ]);
    expect((await ledger().usage(s)).spentUnits).toBe(50);
  });

  it('a failed call stays counted with its error code', async () => {
    const s = await youtubeConnection('failed');
    const m = ledger().meterFor(s);
    await m.settle(await m.reserve(read), { ok: false, errorCode: 'forbidden' });
    expect(await rows(s)).toEqual([
      { outcome: 'error', units: 1, simulated: false, error_code: 'forbidden' },
    ]);
    expect((await ledger().usage(s)).spentUnits).toBe(1);
  });

  it('write that would eat the read reserve is refused with quota_budget_exhausted', async () => {
    const s = await youtubeConnection('reserve');
    const a = await seedTenant(db.c, 'yt-ledger-reserve-user');
    // Budget 200: reserve 100, so one 51-unit batch fits and a second does not.
    await settings.update(s, { dailyBudgetUnits: 200 }, a.userId);
    const m = ledger().meterFor(s);
    await m.reserve({ method: 'comments.list', units: 1, purpose: 'write' });
    await m.reserve(write);
    const err = await refusal(m.reserve(write));
    expect(err.kind).toBe('rate_limited');
    expect(err.code).toBe('quota_budget_exhausted');
    expect(err.retryAfterMs).toBe(nextPacificMidnight(t).getTime() - t);
    // Reads may still use the reserve.
    await m.reserve({ ...read, units: 99 });
    expect((await ledger().usage(s)).spentUnits).toBe(150);
    expect(await rows(s)).toHaveLength(3);
  });

  it('reads are refused at the budget; a connect call needs only the project cap', async () => {
    const s = await youtubeConnection('read-cap');
    const a = await seedTenant(db.c, 'yt-ledger-read-cap-user');
    await settings.update(s, { dailyBudgetUnits: 2 }, a.userId);
    const m = ledger().meterFor(s);
    await m.reserve(read);
    await m.reserve(read);
    expect((await refusal(m.reserve(read))).code).toBe('quota_budget_exhausted');
    await m.reserve({ method: 'channels.list', units: 1, purpose: 'connect' });
    const p = ledger({ projectQuota: 5, projectHeadroom: 1 }).projectMeter();
    await p.reserve({ method: 'channels.list', units: 1, purpose: 'connect' });
    expect(
      (await refusal(p.reserve({ method: 'channels.list', units: 1, purpose: 'connect' }))).code,
    ).toBe('quota_budget_exhausted');
  });

  it('a zero budget refuses every read', async () => {
    const s = await youtubeConnection('zero');
    const a = await seedTenant(db.c, 'yt-ledger-zero-user');
    await settings.update(s, { dailyBudgetUnits: 0 }, a.userId);
    expect((await refusal(ledger().meterFor(s).reserve(read))).code).toBe('quota_budget_exhausted');
    expect(await rows(s)).toEqual([]);
  });

  it('parallel reserves never exceed budget', async () => {
    const s = await youtubeConnection('parallel');
    const a = await seedTenant(db.c, 'yt-ledger-parallel-user');
    await settings.update(s, { dailyBudgetUnits: 120 }, a.userId);
    const wide = createPool(db.db.url, {
      applicationName: 'yt-ledger-parallel',
      onIdleError: () => {},
    });
    try {
      const m = ledger({ pool: wide }).meterFor(s);
      const results = await Promise.allSettled(Array.from({ length: 200 }, () => m.reserve(read)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const refused = results.filter(
        (r) =>
          r.status === 'rejected' &&
          r.reason instanceof ConnectorError &&
          r.reason.code === 'quota_budget_exhausted',
      ).length;
      expect(ok).toBe(120);
      expect(refused).toBe(80);
      expect((await ledger().usage(s)).spentUnits).toBe(120);
    } finally {
      await wide.end();
    }
  });

  it('quotaExceeded settle pauses the whole project until next Pacific midnight', async () => {
    const s1 = await youtubeConnection('pause-1');
    const s2 = await youtubeConnection('pause-2');
    const m1 = ledger().meterFor(s1);
    const ticket = await m1.reserve(read);
    await m1.settle(ticket, { ok: false, errorCode: 'quota_exceeded', quotaExceeded: true });
    expect((await rows(s1))[0]!.outcome).toBe('quota_exceeded');
    const pause = (
      await pool.query<{ pacific_day: string; resume_at: Date; reason: string }>(
        "SELECT to_char(pacific_day, 'YYYY-MM-DD') AS pacific_day, resume_at, reason FROM youtube_quota_pause",
      )
    ).rows;
    expect(pause).toEqual([
      {
        pacific_day: pacificDayKey(t),
        resume_at: nextPacificMidnight(t),
        reason: 'quota_exceeded',
      },
    ]);
    // A second quotaExceeded the same day is a no-op.
    t += 60_000;
    await m1.settle(ticket, { ok: false, quotaExceeded: true });
    expect((await pool.query('SELECT 1 FROM youtube_quota_pause')).rowCount).toBe(1);

    const m2 = ledger().meterFor(s2);
    const err = await refusal(m2.reserve(read));
    expect(err.code).toBe('quota_paused');
    expect(err.retryAfterMs).toBe(nextPacificMidnight(t).getTime() - t);
    expect(
      (
        await refusal(
          ledger()
            .projectMeter()
            .reserve({ method: 'channels.list', units: 1, purpose: 'connect' }),
        )
      ).code,
    ).toBe('quota_paused');
    expect((await ledger().usage(s2)).paused).toBe(true);

    t = nextPacificMidnight(t).getTime() + 1;
    await m2.reserve(read);
    expect((await ledger().usage(s2)).paused).toBe(false);
    expect(logged).toEqual([]);
  });

  it('a failed pause insert is retried once and logged without secrets', async () => {
    const s = await youtubeConnection('retry');
    let failures = 1;
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query')
          return (text: string, values?: unknown[]) => {
            if (text.includes('youtube_quota_pause') && text.includes('INSERT') && failures-- > 0)
              return Promise.reject(new Error('connection reset'));
            return target.query(text, values);
          };
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const m = ledger({ pool: flaky }).meterFor(s);
    await m.settle(await m.reserve(read), { ok: false, quotaExceeded: true });
    expect((await pool.query('SELECT 1 FROM youtube_quota_pause')).rowCount).toBe(1);
    expect(logged.map((l) => l.msg)).toEqual(['youtube_quota.pause_insert_retry']);
    expect(JSON.stringify(logged)).not.toContain('connection reset');
  });

  it('a settle that cannot reach the database is logged, and still pauses when it can', async () => {
    const s = await youtubeConnection('settle-fail');
    const m = ledger().meterFor(s);
    const ticket = await m.reserve(read);
    let failures = 2;
    const broken = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query')
          return (text: string, values?: unknown[]) =>
            failures-- > 0
              ? Promise.reject(new Error('password=hunter2'))
              : target.query(text, values);
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const bm: QuotaMeter = ledger({ pool: broken }).meterFor(s);
    // update fails, first pause insert fails, the retry succeeds
    await expect(bm.settle(ticket, { ok: false, quotaExceeded: true })).rejects.toThrow();
    expect((await pool.query('SELECT 1 FROM youtube_quota_pause')).rowCount).toBe(1);
    expect(logged.map((l) => l.msg)).toEqual([
      'youtube_quota.settle_failed',
      'youtube_quota.pause_insert_retry',
    ]);
    expect(logged[0]!.fields).toMatchObject({ callKey: ticket.callKey, errorName: 'Error' });
    expect(JSON.stringify(logged)).not.toContain('hunter2');
    // The unsettled row still counts.
    expect((await rows(s))[0]!.outcome).toBe('sent');
    expect((await ledger().usage(s)).spentUnits).toBe(1);
  });

  it('simulated rows are excluded from real spend', async () => {
    const s = await youtubeConnection('simulated');
    const a = await seedTenant(db.c, 'yt-ledger-simulated-user');
    // Budget 160, reserve 100: one simulated 50-unit write fits, a second does not.
    await settings.update(s, { dailyBudgetUnits: 160 }, a.userId);
    const sim = ledger().meterFor(s, { simulated: true });
    await sim.settle(await sim.reserve(write), { ok: true });
    await ledger().meterFor(s).reserve(read);
    const u = await ledger().usage(s);
    expect(u.spentUnits).toBe(1);
    expect(u.projectSpentUnits).toBe(1);
    // Both rows share the clock instant, so compare without order.
    expect((await rows(s)).map((r) => [r.simulated, r.units]).sort()).toEqual([
      [false, 1],
      [true, 50],
    ]);
    // The simulated allowance is spent by simulated rows: a second simulated batch does not fit.
    expect((await refusal(sim.reserve(write))).code).toBe('quota_budget_exhausted');
    // Real writes still see the real allowance.
    await ledger().meterFor(s).reserve(write);
    expect(await ledger().dailyTotals(s, pacificDayKey(t))).toEqual([
      { method: 'commentThreads.list', purpose: 'read', units: 1, calls: 1 },
      { method: 'comments.setModerationStatus', purpose: 'write', units: 50, calls: 1 },
    ]);
  });

  it('simulated usage counts real and simulated rows; the project total stays real', async () => {
    const s = await youtubeConnection('simulated-usage');
    const sim = ledger().meterFor(s, { simulated: true });
    await sim.settle(await sim.reserve({ ...write, units: 51 }), { ok: true });
    await ledger().meterFor(s).reserve(read);
    const u = await ledger().usage(s, { simulated: true });
    expect(u.spentUnits).toBe(52);
    expect(u.readsSpentUnits).toBe(1);
    expect((await ledger().usage(s)).spentUnits).toBe(1);
    expect(u.projectSpentUnits).toBe((await ledger().usage(s)).projectSpentUnits);
  });

  it("usage and totals never count another tenant's rows", async () => {
    const s1 = await youtubeConnection('tenant-1');
    const s2 = await youtubeConnection('tenant-2');
    await ledger().meterFor(s1).reserve(read);
    await ledger().meterFor(s1).reserve(read);
    await ledger().meterFor(s2).reserve(read);
    expect((await ledger().usage(s2)).spentUnits).toBe(1);
    expect((await ledger().usage(s2)).projectSpentUnits).toBe(3);
    const foreign = { ...s2, connectionId: s1.connectionId };
    expect((await ledger().usage(foreign)).spentUnits).toBe(0);
    expect(await ledger().dailyTotals(foreign, pacificDayKey(t))).toEqual([]);
  });

  it('the day rolls over at Pacific midnight', async () => {
    const s = await youtubeConnection('rollover');
    const m = ledger().meterFor(s);
    await m.reserve(read);
    t = nextPacificMidnight(t).getTime() - 1;
    await m.reserve(read);
    expect((await ledger().usage(s)).spentUnits).toBe(2);
    t += 1;
    expect((await ledger().usage(s)).spentUnits).toBe(0);
    await m.reserve(read);
    expect((await ledger().usage(s)).spentUnits).toBe(1);
  });

  it('prune drops rows past the retention window and keeps the rest', async () => {
    const s = await youtubeConnection('prune');
    const m = ledger().meterFor(s);
    await m.reserve(read);
    await pool.query('UPDATE youtube_quota_ledger SET pacific_day = pacific_day - $1::int', [
      LEDGER_RETENTION_DAYS + 1,
    ]);
    await m.reserve(read);
    await pool.query(
      `INSERT INTO youtube_quota_ledger (call_key, pacific_day, method, purpose, units)
       VALUES ('edge', $1::date - $2::int, 'channels.list', 'connect', 1)`,
      [pacificDayKey(t), LEDGER_RETENTION_DAYS],
    );
    expect(await ledger().prune()).toBe(1);
    const left = await pool.query('SELECT count(*)::int AS n FROM youtube_quota_ledger');
    expect(left.rows[0].n).toBe(2);
  });
});

describe('PgYouTubeSettings in a caller transaction', () => {
  it('rolls back with the transaction', async () => {
    const s = await youtubeConnection('settings-tx');
    const a = await seedTenant(db.c, 'yt-ledger-settings-tx-user');
    await expect(
      withTransaction(pool, async (tx) => {
        await settings.update(s, { dailyBudgetUnits: 123 }, a.userId, tx);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect((await settings.get(s)).dailyBudgetUnits).toBe(2000);
  });
});
