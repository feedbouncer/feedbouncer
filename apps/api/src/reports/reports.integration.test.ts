import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@feedbouncer/db';
import { seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import {
  PgReportSubscriptions,
  WeeklyReportDispatcher,
  WeeklyReportScheduler,
  buildView,
  computeWeeklyStats,
  periodForWeek,
  rankTopAds,
  reportPeriod,
  type ReportPeriod,
  type WeeklyStats,
} from '@feedbouncer/reports';
import type { Logger } from '@feedbouncer/service-runtime';
import { seedAd, seedHide, seedProcessed, seedSource } from '@feedbouncer/reports/testing';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

const TZ = 'Europe/Berlin';
const DAY_MS = 86_400_000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let api: TestApi;
let tn: Tenant;
let users: Record<'owner' | 'admin' | 'member', TestUser>;
let other: OrgFixture;
let subs: PgReportSubscriptions;
/** The last complete week, and the weeks 1-3 before it. */
let last: ReportPeriod;
let liveWeek: ReportPeriod;
let snapshotWeek: string;
let missedWeek: string;

const weekBefore = (week: string, n: number) =>
  new Date(Date.parse(`${week}T00:00:00Z`) - n * 7 * DAY_MS).toISOString().slice(0, 10);
const weekly = (week?: string, cookie = users.owner.cookie) =>
  api.req(
    'GET',
    `/api/v1/orgs/${tn.organizationId}/reports/weekly${week === undefined ? '' : `?week=${week}`}`,
    { cookie },
  );

beforeAll(async () => {
  api = await startTestApi();
  subs = new PgReportSubscriptions(api.pool, api.deps.env.encryption);
  const c = await api.pool.connect();
  try {
    tn = await seedTenant(c, 'rpa');
    await c.query('UPDATE organization SET timezone = $2 WHERE id = $1', [tn.organizationId, TZ]);
    users = {
      owner: await verifiedUser(api, 'rp-owner'),
      admin: await verifiedUser(api, 'rp-admin'),
      member: await verifiedUser(api, 'rp-member'),
    };
    for (const [role, u] of Object.entries(users))
      await c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
        tn.organizationId,
        u.userId,
        role,
      ]);
    last = await reportPeriod(c, TZ, new Date());
    liveWeek = (await periodForWeek(c, TZ, weekBefore(last.weekStart, 1)))!;
    snapshotWeek = weekBefore(last.weekStart, 2);
    missedWeek = weekBefore(last.weekStart, 3);

    // The live week: an ad with 12 comments, 4 hidden by the classifier, and one other comment.
    const postedAt = new Date(liveWeek.start.getTime() + DAY_MS);
    const adSource = await seedSource(c, tn);
    await seedAd(c, tn, { name: 'Spring sale', sourceId: adSource });
    for (let i = 0; i < 12; i++) {
      const id = await seedProcessed(c, tn, { postedAt, sourceId: adSource });
      if (i < 4) await seedHide(c, tn, id, { by: 'classifier', at: postedAt });
    }
    await seedProcessed(c, tn, { postedAt });

    await c.query(
      `INSERT INTO weekly_report (organization_id, week_start, timezone, period_start, period_end, status,
         payload, computed_at)
       VALUES ($1, $2::date, $3, now() - interval '30 days', now() - interval '23 days', 'queued', $4, now()),
              ($1, $5::date, $3, now() - interval '37 days', now() - interval '30 days', 'missed', NULL, now())`,
      [
        tn.organizationId,
        snapshotWeek,
        TZ,
        { version: 1, marker: 'stored', processed: 7 },
        missedWeek,
      ],
    );
  } finally {
    c.release();
  }
  other = await orgWithRoles(api, 'rpB');
});
afterAll(() => api.close());

describe('weekly report dashboard', () => {
  it('owner and admin get stats; member → 403; org B owner → 404', async () => {
    const owner = await weekly();
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ weekStart: last.weekStart, timezone: TZ, source: 'live' });
    expect((await weekly(undefined, users.admin.cookie)).status).toBe(200);
    const member = await weekly(undefined, users.member.cookie);
    expect(member.status).toBe(403);
    expect(member.body.error.code).toBe('forbidden');
    const outsider = await weekly(undefined, other.owner.cookie);
    expect(outsider.status).toBe(404);
    expect(outsider.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('week=2026-10-13 (Tuesday) → 400 invalid_week; future week → 400; 60 weeks ago → 400', async () => {
    const current = weekBefore(last.weekStart, -1);
    for (const week of [
      '2026-10-13',
      current,
      weekBefore(last.weekStart, -5),
      weekBefore(last.weekStart, 60),
      weekBefore(last.weekStart, 52),
      '2026-1-5',
      '2026-02-30',
      '2026-13-45',
      'monday',
      '',
    ]) {
      const r = await weekly(week);
      expect(r.status, week).toBe(400);
      expect(r.body.error.code).toBe('invalid_week');
    }
    const oldest = await weekly(weekBefore(last.weekStart, 51));
    expect(oldest.status).toBe(200);
  });

  it('snapshot week returns source snapshot and the exact stored payload', async () => {
    const r = await weekly(snapshotWeek);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      weekStart: snapshotWeek,
      timezone: TZ,
      source: 'snapshot',
      stats: { version: 1, marker: 'stored', processed: 7 },
      weeks: [snapshotWeek, missedWeek],
    });
    const missed = await weekly(missedWeek);
    expect(missed.body.source).toBe('live');
  });

  it('live week equals computeWeeklyStats for the same period', async () => {
    const r = await weekly(liveWeek.weekStart);
    expect(r.status).toBe(200);
    const expected = await withTransaction(api.pool, (c) =>
      computeWeeklyStats(c, tn.organizationId, liveWeek, liveWeek.dueAt),
    );
    expected.ads = rankTopAds(expected.ads);
    expect(expected).toMatchObject({ processed: 13, hidden: 4 });
    expect(expected.ads).toHaveLength(1);
    expect(r.body).toEqual({
      weekStart: liveWeek.weekStart,
      timezone: TZ,
      source: 'live',
      stats: expected,
      weeks: [snapshotWeek, missedWeek],
    });
  });
});

describe('report subscriptions', () => {
  const mine = async (u: TestUser) => {
    const r = await api.req('GET', '/api/v1/me/report-subscriptions', { cookie: u.cookie });
    expect(r.status).toBe(200);
    return r.body.subscriptions as { organizationId: string; subscribed: boolean }[];
  };
  const put = (u: TestUser, orgId: string, body: unknown) =>
    api.req('PUT', `/api/v1/me/report-subscriptions/${orgId}`, { cookie: u.cookie, body });

  it('GET/PUT me/report-subscriptions: admin toggles off then on; member PUT → 404; PUT for org B → 404', async () => {
    expect(await mine(users.admin)).toEqual([
      {
        organizationId: tn.organizationId,
        organizationName: 'Org rpa',
        subscribed: true,
      },
    ]);
    expect((await put(users.admin, tn.organizationId, { subscribed: false })).status).toBe(204);
    expect((await mine(users.admin))[0]!.subscribed).toBe(false);
    expect((await put(users.admin, tn.organizationId, { subscribed: true })).status).toBe(204);
    expect((await mine(users.admin))[0]!.subscribed).toBe(true);

    expect(await mine(users.member)).toEqual([]);
    expect((await put(users.member, tn.organizationId, { subscribed: false })).status).toBe(404);
    expect((await put(users.admin, other.orgId, { subscribed: false })).status).toBe(404);
    expect((await put(users.admin, 'not-a-uuid', { subscribed: false })).status).toBe(404);
    const bad = await put(users.admin, tn.organizationId, { subscribed: 'no' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_request');
    const n = await api.pool.query(
      "SELECT count(*)::int AS n FROM report_subscription WHERE user_id = $1 AND status = 'unsubscribed'",
      [users.member.userId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('POST unsubscribe with form body One-Click → unsubscribed; replay → already; garbage → 200 invalid; no Origin header needed', async () => {
    const token = await withTransaction(api.pool, (c) =>
      subs.ensureToken(c, tn.organizationId, users.owner.userId),
    );
    const url = (t?: string) =>
      `/api/v1/report-subscriptions/unsubscribe${t === undefined ? '' : `?token=${t}`}`;
    const post = (t?: string, body = 'List-Unsubscribe=One-Click') =>
      api.raw('POST', url(t), { headers: FORM, body });

    const first = await post(token);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ status: 'unsubscribed' });
    expect((await mine(users.owner))[0]!.subscribed).toBe(false);
    expect(JSON.parse((await post(token)).text)).toEqual({ status: 'already' });

    for (const t of [
      'garbage',
      'a'.repeat(43),
      `${token}x`,
      undefined,
      `${token}&token=${token}`,
    ]) {
      const r = await post(t);
      expect(r.status, String(t)).toBe(200);
      expect(JSON.parse(r.text)).toEqual({ status: 'invalid' });
    }

    // An empty body (the web page's button) and a foreign Origin are accepted too.
    const bToken = await withTransaction(api.pool, (c) =>
      subs.ensureToken(c, other.orgId, other.owner.userId),
    );
    const empty = await api.raw('POST', url(bToken), {
      headers: { origin: 'https://mail.example' },
    });
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.text)).toEqual({ status: 'unsubscribed' });

    const wrongForm = await post(token, 'List-Unsubscribe=Maybe');
    expect(wrongForm.status).toBe(400);
    expect(JSON.parse(wrongForm.text).error.code).toBe('invalid_request');
    expect(api.logLines.join('\n')).not.toContain(token);
  });
});

describe('email and dashboard parity', () => {
  it('the API response for a sent week, rendered through buildView, matches the email text', async () => {
    const c = await api.pool.connect();
    try {
      const postedAt = new Date(last.start.getTime() + DAY_MS);
      const adSource = await seedSource(c, tn);
      await seedAd(c, tn, { name: 'Autumn <b>deal</b>', sourceId: adSource });
      for (let i = 0; i < 10; i++) {
        const id = await seedProcessed(c, tn, { postedAt, sourceId: adSource });
        if (i < 3)
          await seedHide(c, tn, id, { by: 'classifier', category: 'scam_phishing', at: postedAt });
      }
      const id = await seedProcessed(c, tn, { postedAt, via: 'rule' });
      await seedHide(c, tn, id, { by: 'rule', at: postedAt });
    } finally {
      c.release();
    }
    const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const dueNow = new Date(last.dueAt.getTime() + 60_000);
    await new WeeklyReportScheduler({ pool: api.pool, log, now: () => dueNow }).tick();
    const mailer = new MemoryMailer();
    await new WeeklyReportDispatcher({
      pool: api.pool,
      log,
      mailer,
      subscriptions: subs,
      web: api.deps.env.publicWebUrl,
      now: () => dueNow,
    }).tick();
    // The owner unsubscribed above; the admin re-subscribed.
    const text = mailer.lastTo(users.admin.email)!.text;

    const r = await weekly(last.weekStart);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('snapshot');
    const view = buildView(r.body.stats as WeeklyStats, 'Org rpa');
    expect(view).toMatchObject({ processedLine: '11 comments processed', totalHidden: '4' });
    const ads = view.topAds as Exclude<typeof view.topAds, 'none_qualify' | null>;
    expect(ads.map((a) => a.ad)).toEqual([expect.stringMatching(/^Autumn <b>deal<\/b> · #/)]);
    for (const s of [
      view.range,
      view.processedLine,
      view.changeLine,
      ...view.categories!.map((x) => `${x.label} — ${x.count} (${x.share})`),
      `Total hidden: ${view.totalHidden}`,
      ...ads.map(
        (a) => `${a.ad} — ${a.platform}: ${a.hidden} hidden of ${a.total} comments, ${a.share}`,
      ),
      view.timeSaved,
    ])
      expect(text).toContain(s);
  });
});
