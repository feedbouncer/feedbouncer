import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { Logger, LogFields } from '@feedbouncer/service-runtime';
import { WeeklyReportScheduler } from './scheduler.js';
import { PgReportSubscriptions } from './subscriptions.js';
import { seedProcessed } from './testing.js';

const failing = vi.hoisted(() => new Set<string>());
vi.mock('./stats.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./stats.js')>();
  return {
    ...orig,
    computeWeeklyStats: (...args: Parameters<typeof orig.computeWeeklyStats>) => {
      if (failing.has(args[1])) return Promise.reject(new TypeError('stub stats failure'));
      return orig.computeWeeklyStats(...args);
    },
  };
});

const HOUR = 3_600_000;
// Europe/Berlin is UTC+2 until 2026-10-25; Monday 2026-10-26 08:00 local is 07:00Z (UTC+1).
const BERLIN_DUE = new Date('2026-10-26T07:00:00Z');
const BERLIN_MID = new Date('2026-10-21T12:00:00Z');

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let logs: { msg: string; fields?: LogFields }[];
let n = 0;

const log: Logger = {
  debug: () => {},
  info: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
  warn: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
  error: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
};

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'reports-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM organization');
  failing.clear();
  logs = [];
});

const scheduler = (now: Date) => new WeeklyReportScheduler({ pool, log, now: () => now });

async function org(timezone = 'Europe/Berlin', comments = 1, at = BERLIN_MID): Promise<Tenant> {
  const t = await seedTenant(h.c, `sch${++n}`);
  await h.c.query('UPDATE organization SET timezone = $2 WHERE id = $1', [
    t.organizationId,
    timezone,
  ]);
  await h.c.query('UPDATE app_user SET email_verified = true WHERE id = $1', [t.userId]);
  for (let i = 0; i < comments; i++) await seedProcessed(h.c, t, { postedAt: at });
  return t;
}

async function member(t: Tenant, role: 'owner' | 'admin' | 'member', verified = true) {
  const id = (
    await h.c.query<{ id: string }>(
      'INSERT INTO app_user (email, email_verified) VALUES ($1, $2) RETURNING id',
      [`m-${uuid()}@example.test`, verified],
    )
  ).rows[0]!.id;
  await h.c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
    t.organizationId,
    id,
    role,
  ]);
  return id;
}

const reports = async (t: Tenant) =>
  (
    await h.c.query(
      `SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, timezone, status, payload,
              period_start, period_end, computed_at
         FROM weekly_report WHERE organization_id = $1 ORDER BY week_start`,
      [t.organizationId],
    )
  ).rows;

const deliveries = async (t: Tenant) =>
  (
    await h.c.query(
      `SELECT user_id, state, attempts, next_attempt_at FROM weekly_report_delivery
        WHERE organization_id = $1 ORDER BY user_id`,
      [t.organizationId],
    )
  ).rows;

const none = { created: 0, quiet: 0, missed: 0, failed: 0 };

describe('WeeklyReportScheduler', () => {
  it('not due at Monday 07:59 local; due at 08:00 local (Europe/Berlin, 2026-10-26T07:00Z)', async () => {
    const t = await org();
    expect(await scheduler(new Date(BERLIN_DUE.getTime() - 60_000)).tick()).toEqual(none);
    expect(await reports(t)).toEqual([]);
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1 });
    expect(await reports(t)).toMatchObject([
      {
        week_start: '2026-10-19',
        timezone: 'Europe/Berlin',
        status: 'queued',
        period_start: new Date('2026-10-18T22:00:00Z'),
        period_end: new Date('2026-10-25T23:00:00Z'),
        computed_at: BERLIN_DUE,
      },
    ]);
  });

  it('creates one queued report with one delivery per verified, subscribed owner/admin; member, unverified and unsubscribed users excluded', async () => {
    const t = await org('Europe/Berlin', 3);
    const admin = await member(t, 'admin');
    await member(t, 'member');
    await member(t, 'admin', false);
    const unsubscribed = await member(t, 'owner');
    const subs = new PgReportSubscriptions(pool, testKeyring(['k1']));
    await subs.unsubscribeByToken(await subs.ensureToken(h.c, t.organizationId, unsubscribed));

    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1 });
    const [r] = await reports(t);
    expect(r.payload).toMatchObject({
      version: 1,
      organizationId: t.organizationId,
      weekStart: '2026-10-19',
      processed: 3,
    });
    expect(await deliveries(t)).toEqual(
      [t.userId, admin].sort().map((user_id) => ({
        user_id,
        state: 'pending',
        attempts: 0,
        next_attempt_at: BERLIN_DUE,
      })),
    );
    expect(logs).toContainEqual({
      msg: 'reports.created',
      fields: {
        organizationId: t.organizationId,
        weekStart: '2026-10-19',
        reportId: r.id,
        deliveries: 2,
      },
    });
  });

  it('quiet week → skipped_quiet, no deliveries', async () => {
    const t = await org('Europe/Berlin', 0);
    await seedProcessed(h.c, t, { postedAt: new Date('2026-10-14T12:00:00Z') });
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, quiet: 1 });
    expect(await reports(t)).toMatchObject([{ status: 'skipped_quiet', payload: null }]);
    expect(await deliveries(t)).toEqual([]);
  });

  it('more than 24 h late → missed, no deliveries', async () => {
    const onTime = await org();
    expect(await scheduler(new Date(BERLIN_DUE.getTime() + 24 * HOUR)).tick()).toEqual({
      ...none,
      created: 1,
    });
    const late = await org();
    expect(await scheduler(new Date(BERLIN_DUE.getTime() + 24 * HOUR + 1)).tick()).toEqual({
      ...none,
      missed: 1,
    });
    expect(await reports(late)).toMatchObject([
      { week_start: '2026-10-19', status: 'missed', payload: null },
    ]);
    expect(await deliveries(late)).toEqual([]);
    expect(await deliveries(onTime)).toHaveLength(1);
    expect(logs).toContainEqual({
      msg: 'reports.missed',
      fields: { organizationId: late.organizationId, weekStart: '2026-10-19' },
    });
  });

  it('rerun and duplicate trigger: tick twice, and two schedulers in parallel → one report, one delivery per recipient', async () => {
    const t = await org();
    await member(t, 'admin');
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1 });
    expect(await scheduler(new Date(BERLIN_DUE.getTime() + HOUR)).tick()).toEqual(none);
    expect(await reports(t)).toHaveLength(1);
    expect(await deliveries(t)).toHaveLength(2);

    const orgs = await Promise.all([org(), org(), org()]);
    await Promise.all(orgs.map((o) => member(o, 'admin')));
    const results = await Promise.all([1, 2, 3, 4].map(() => scheduler(BERLIN_DUE).tick()));
    expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(3);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    for (const o of orgs) {
      expect(await reports(o)).toHaveLength(1);
      expect(await deliveries(o)).toHaveLength(2);
    }
  });

  it('one org whose stats query throws (stub) does not stop the next org from being created', async () => {
    const [x, y] = (await Promise.all([org(), org()])).sort((a, b) =>
      a.organizationId < b.organizationId ? -1 : 1,
    );
    failing.add(x!.organizationId);
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1, failed: 1 });
    expect(await reports(x!)).toEqual([]);
    expect(await reports(y!)).toHaveLength(1);
    expect(logs).toContainEqual({
      msg: 'reports.compute_failed',
      fields: { organizationId: x!.organizationId, weekStart: '2026-10-19', error: 'TypeError' },
    });
    failing.clear();
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1 });
  });

  it('a failing org is backed off, so it cannot starve later orgs when the batch is small', async () => {
    const [x, y] = (await Promise.all([org(), org()])).sort((a, b) =>
      a.organizationId < b.organizationId ? -1 : 1,
    );
    failing.add(x!.organizationId);
    const s = new WeeklyReportScheduler({ pool, log, now: () => BERLIN_DUE, batch: 1 });
    expect(await s.tick()).toEqual({ ...none, failed: 1 });
    expect(await s.tick()).toEqual({ ...none, created: 1 });
    expect(await reports(y!)).toHaveLength(1);
  });

  it('two orgs in different timezones become due at their own local 08:00', async () => {
    const berlin = await org('Europe/Berlin');
    // America/New_York is still on EDT (UTC-4) on 2026-10-26: 08:00 local is 12:00Z.
    const ny = await org('America/New_York');
    expect(await scheduler(BERLIN_DUE).tick()).toEqual({ ...none, created: 1 });
    expect(await reports(berlin)).toHaveLength(1);
    expect(await scheduler(new Date('2026-10-26T11:59:59Z')).tick()).toEqual(none);
    expect(await scheduler(new Date('2026-10-26T12:00:00Z')).tick()).toEqual({
      ...none,
      created: 1,
    });
    expect(await reports(ny)).toMatchObject([
      {
        week_start: '2026-10-19',
        period_start: new Date('2026-10-19T04:00:00Z'),
        period_end: new Date('2026-10-26T04:00:00Z'),
      },
    ]);
  });

  it('New York spring-forward week is due at 2026-03-09T12:00Z', async () => {
    const ny = await org('America/New_York', 1, new Date('2026-03-08T12:00:00Z'));
    expect(await scheduler(new Date('2026-03-09T11:59:59Z')).tick()).toEqual(none);
    expect(await scheduler(new Date('2026-03-09T12:00:00Z')).tick()).toEqual({
      ...none,
      created: 1,
    });
    expect(await reports(ny)).toMatchObject([
      {
        week_start: '2026-03-02',
        period_start: new Date('2026-03-02T05:00:00Z'),
        period_end: new Date('2026-03-09T04:00:00Z'),
      },
    ]);
  });
});
