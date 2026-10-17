// The email and the Weekly report page must show the same numbers: both render buildView of the
// same stats. The API answers a queued week with the stored payload, and any other week with
// computeWeeklyStats + rankTopAds as of the due time; this test checks both against the email.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { Logger } from '@feedbouncer/service-runtime';
import { WeeklyReportDispatcher } from './dispatcher.js';
import { periodForWeek } from './period.js';
import { rankTopAds } from './rank.js';
import { WeeklyReportScheduler } from './scheduler.js';
import { computeWeeklyStats, type WeeklyStats } from './stats.js';
import { PgReportSubscriptions } from './subscriptions.js';
import { seedAd, seedHide, seedProcessed, seedSource } from './testing.js';
import { buildView } from './view.js';

const web = new URL('https://app.example.test');
const WEEK = '2026-10-12';
const DUE = new Date('2026-10-19T08:00:00Z');
const MID = new Date('2026-10-14T12:00:00Z');
const PREV = new Date('2026-10-07T12:00:00Z');
const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'reports-parity', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

describe('weekly report parity', () => {
  it('email numbers match dashboard', async () => {
    const tn = await seedTenant(h.c, 'parity-a');
    await h.c.query('UPDATE app_user SET email_verified = true WHERE id = $1', [tn.userId]);
    const source = await seedSource(h.c, tn);
    await seedAd(h.c, tn, { name: 'Spring sale', sourceId: source });
    for (let i = 0; i < 15; i++) {
      const id = await seedProcessed(h.c, tn, { postedAt: MID, sourceId: source });
      if (i < 4) await seedHide(h.c, tn, id, { by: 'classifier', at: MID });
      else if (i < 6) await seedHide(h.c, tn, id, { by: 'rule', at: MID });
    }
    for (let i = 0; i < 3; i++) {
      const id = await seedProcessed(h.c, tn, { postedAt: MID });
      await seedHide(h.c, tn, id, { by: 'classifier', category: 'harassment_abuse', at: MID });
    }
    for (let i = 0; i < 7; i++) await seedProcessed(h.c, tn, { postedAt: PREV });

    expect((await new WeeklyReportScheduler({ pool, log, now: () => DUE }).tick()).created).toBe(1);
    const mailer = new MemoryMailer();
    const subscriptions = new PgReportSubscriptions(pool, testKeyring(['k1']));
    const sentAt = new Date(DUE.getTime() + 60_000);
    await new WeeklyReportDispatcher({
      pool,
      log,
      mailer,
      subscriptions,
      web,
      now: () => sentAt,
    }).tick();
    expect(mailer.sent).toHaveLength(1);
    const text = mailer.sent[0]!.text;

    // The snapshot the API returns for a queued week.
    const stored = await h.c.query<{ payload: WeeklyStats }>(
      `SELECT payload FROM weekly_report WHERE organization_id = $1 AND week_start = $2::date`,
      [tn.organizationId, WEEK],
    );
    const snapshot = stored.rows[0]!.payload;
    // The API's live path for the same week, as of the due time.
    const live = await withTransaction(pool, async (c) => {
      const p = (await periodForWeek(c, 'UTC', WEEK))!;
      const s = await computeWeeklyStats(c, tn.organizationId, p, p.dueAt);
      s.ads = rankTopAds(s.ads);
      return s;
    });
    expect(live).toEqual(snapshot);

    const view = buildView(snapshot, 'Org parity-a');
    expect(view).toMatchObject({
      processedLine: '18 comments processed',
      totalHidden: '9',
      timeSaved: '5 min',
    });
    const ads = view.topAds as Exclude<typeof view.topAds, 'none_qualify' | null>;
    expect(ads).toHaveLength(1);
    for (const s of [
      view.range,
      view.processedLine,
      view.changeLine,
      ...view.categories!.map((c) => `${c.label} — ${c.count} (${c.share})`),
      `Total hidden: ${view.totalHidden}`,
      ...ads.flatMap((a) => [
        a.ad,
        a.platform,
        `${a.hidden} hidden of ${a.total} comments`,
        a.share,
      ]),
      view.timeSaved,
      view.timeSavedNote,
    ])
      expect(text).toContain(s);
  });
});
