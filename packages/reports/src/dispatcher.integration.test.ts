import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { LEASE_MS, RETRY_DELAYS_MS } from '@feedbouncer/alerts';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import type { Mailer, OutboundEmail } from '@feedbouncer/mailer';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { Logger, LogFields } from '@feedbouncer/service-runtime';
import { WeeklyReportDispatcher } from './dispatcher.js';
import { WeeklyReportScheduler } from './scheduler.js';
import { PgReportSubscriptions } from './subscriptions.js';
import { seedAd, seedHide, seedProcessed } from './testing.js';

const web = new URL('https://app.example.test');
const SECRET_BODY = 'sentinel comment body about refunds';
const DUE = new Date('2026-10-19T08:00:00Z');
const MID = new Date('2026-10-14T12:00:00Z');
const MIN = 60_000;

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let subs: PgReportSubscriptions;
let mailer: MemoryMailer;
let now: Date;
let logs: { msg: string; fields?: LogFields }[];
let n = 0;

const log: Logger = {
  debug: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
  info: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
  warn: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
  error: (msg, fields) => logs.push({ msg, ...(fields && { fields }) }),
};

/** Fails sends to the listed addresses with the given SMTP codes, in order, then delivers. */
class StubMailer implements Mailer {
  calls = 0;
  constructor(
    private readonly failures: Map<string, number[]>,
    private readonly inner: Mailer,
  ) {}
  send(m: OutboundEmail): Promise<void> {
    this.calls++;
    const code = this.failures.get(m.to)?.shift();
    if (code === undefined) return this.inner.send(m);
    return Promise.reject(new Error('smtp', { cause: { responseCode: code } }));
  }
}

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'reports-test', onIdleError: () => {} });
  subs = new PgReportSubscriptions(pool, testKeyring(['k1']), () => now);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM organization');
  mailer = new MemoryMailer();
  now = new Date(DUE.getTime() + MIN);
  logs = [];
});

const dispatcher = (m: Mailer = mailer) =>
  new WeeklyReportDispatcher({ pool, log, mailer: m, subscriptions: subs, web, now: () => now });

const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

async function org(label = `dsp${++n}`): Promise<Tenant> {
  const t = await seedTenant(h.c, label);
  await h.c.query('UPDATE app_user SET email_verified = true WHERE id = $1', [t.userId]);
  await seedProcessed(h.c, t, { postedAt: MID });
  return t;
}

async function member(t: Tenant, role: 'owner' | 'admin' | 'member' = 'admin', userId?: string) {
  const id =
    userId ??
    (
      await h.c.query<{ id: string }>(
        'INSERT INTO app_user (email, email_verified) VALUES ($1, true) RETURNING id',
        [`m-${uuid()}@example.test`],
      )
    ).rows[0]!.id;
  await h.c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
    t.organizationId,
    id,
    role,
  ]);
  return id;
}

const email = async (userId: string) =>
  (await h.c.query<{ email: string }>('SELECT email FROM app_user WHERE id = $1', [userId]))
    .rows[0]!.email;

async function schedule() {
  const r = await new WeeklyReportScheduler({ pool, log, now: () => DUE }).tick();
  expect(r.failed).toBe(0);
}

const delivery = async (t: Tenant, userId: string) =>
  (
    await h.c.query(
      `SELECT id, state, attempts, last_error_code, lease_until, sent_at, next_attempt_at
         FROM weekly_report_delivery WHERE organization_id = $1 AND user_id = $2`,
      [t.organizationId, userId],
    )
  ).rows[0];

const none = { sent: 0, retried: 0, failed: 0, cancelled: 0, reaped: 0 };

describe('WeeklyReportDispatcher', () => {
  it('sends one email per delivery with html and text; marks sent', async () => {
    const t = await org('send-a');
    const admin = await member(t);
    await schedule();
    expect(await dispatcher().tick()).toEqual({ ...none, sent: 2 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(
      [await email(t.userId), await email(admin)].sort(),
    );
    const d = await delivery(t, t.userId);
    expect(d).toMatchObject({
      state: 'sent',
      attempts: 1,
      last_error_code: null,
      lease_until: null,
      sent_at: now,
    });
    const m = mailer.lastTo(await email(t.userId))!;
    expect(m.subject).toBe('Your FeedBouncer week for Org send-a: Oct 12 – Oct 18, 2026 (UTC)');
    expect(m.html).toMatch(/^<!doctype html>/);
    expect(m.html).toContain('Comments processed');
    expect(m.text).toContain('1 comments processed');
    expect(m.text).toContain("You're receiving this because you're an owner of");
    expect(m.messageId).toBe(`<weekly-${d.id}@app.example.test>`);
    expect(m.headers?.['List-Unsubscribe']).toMatch(
      /^<https:\/\/app\.example\.test\/api\/v1\/report-subscriptions\/unsubscribe\?token=[A-Za-z0-9_-]{43}>, </,
    );
    expect(mailer.lastTo(await email(admin))!.text).toContain("you're an admin of");
    later(10 * MIN);
    expect(await dispatcher().tick()).toEqual(none);
    expect(mailer.sent).toHaveLength(2);
  });

  it('retry: transient 421 ×2 then success → exactly one email in MemoryMailer, attempts 3', async () => {
    const t = await org();
    await schedule();
    const stub = new StubMailer(new Map([[await email(t.userId), [421, 421]]]), mailer);
    expect(await dispatcher(stub).tick()).toEqual({ ...none, retried: 1 });
    expect(await delivery(t, t.userId)).toMatchObject({
      state: 'retrying',
      attempts: 1,
      last_error_code: 'smtp_421',
      lease_until: null,
      next_attempt_at: new Date(now.getTime() + RETRY_DELAYS_MS[0]),
    });
    later(RETRY_DELAYS_MS[0] - 1);
    expect(await dispatcher(stub).tick()).toEqual(none);
    later(1);
    expect(await dispatcher(stub).tick()).toEqual({ ...none, retried: 1 });
    later(RETRY_DELAYS_MS[1]);
    expect(await dispatcher(stub).tick()).toEqual({ ...none, sent: 1 });
    expect(mailer.sent).toHaveLength(1);
    expect(stub.calls).toBe(3);
    expect(await delivery(t, t.userId)).toMatchObject({
      state: 'sent',
      attempts: 3,
      last_error_code: null,
    });
  });

  it('550 → failed invalid, no retry', async () => {
    const t = await org();
    await schedule();
    const stub = new StubMailer(new Map([[await email(t.userId), [550]]]), mailer);
    expect(await dispatcher(stub).tick()).toEqual({ ...none, failed: 1 });
    expect(await delivery(t, t.userId)).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error_code: 'smtp_550',
    });
    later(RETRY_DELAYS_MS.at(-1)! * 2);
    expect(await dispatcher(stub).tick()).toEqual(none);
    expect(stub.calls).toBe(1);
    expect(mailer.sent).toEqual([]);
  });

  it('transient ×6 → failed retries_exhausted after the schedule', async () => {
    const t = await org();
    await schedule();
    const stub = new StubMailer(new Map([[await email(t.userId), Array(10).fill(451)]]), mailer);
    for (const delay of RETRY_DELAYS_MS) {
      expect(await dispatcher(stub).tick()).toEqual({ ...none, retried: 1 });
      later(delay);
    }
    expect(await dispatcher(stub).tick()).toEqual({ ...none, failed: 1 });
    expect(await delivery(t, t.userId)).toMatchObject({
      state: 'failed',
      attempts: RETRY_DELAYS_MS.length + 1,
      last_error_code: 'retries_exhausted',
    });
    later(RETRY_DELAYS_MS.at(-1)! * 2);
    expect(await dispatcher(stub).tick()).toEqual(none);
    expect(stub.calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(mailer.sent).toEqual([]);
  });

  it('expired sending lease → failed outcome_unknown, never resent', async () => {
    const t = await org();
    const admin = await member(t);
    await schedule();
    // A worker claimed both and crashed after SMTP accepted; one lease has expired, one has not.
    await h.c.query(
      `UPDATE weekly_report_delivery SET state = 'sending', attempts = 1,
              lease_until = CASE WHEN user_id = $2 THEN $3::timestamptz ELSE $4::timestamptz END
        WHERE organization_id = $1`,
      [t.organizationId, t.userId, new Date(now.getTime() - 1), new Date(now.getTime() + MIN)],
    );
    expect(await dispatcher().tick()).toEqual({ ...none, reaped: 1 });
    expect(await delivery(t, t.userId)).toMatchObject({
      state: 'failed',
      attempts: 1,
      last_error_code: 'outcome_unknown',
      lease_until: null,
    });
    expect(await delivery(t, admin)).toMatchObject({ state: 'sending' });
    later(LEASE_MS + RETRY_DELAYS_MS.at(-1)!);
    expect(await dispatcher().tick()).toEqual({ ...none, reaped: 1 });
    expect(await dispatcher().tick()).toEqual(none);
    expect(mailer.sent).toEqual([]);
    expect(logs).toContainEqual({
      msg: 'reports.delivery_failed',
      fields: {
        deliveryId: (await delivery(t, admin)).id,
        organizationId: t.organizationId,
        code: 'outcome_unknown',
      },
    });
  });

  it('two dispatchers in parallel → one send per delivery', async () => {
    const orgs = await Promise.all([org(), org()]);
    for (const t of orgs) for (let i = 0; i < 6; i++) await member(t);
    await schedule();
    const slow: Mailer = {
      send: async (m) => {
        await new Promise((r) => setTimeout(r, 5));
        await mailer.send(m);
      },
    };
    const results = await Promise.all([1, 2, 3].map(() => dispatcher(slow).tick()));
    const total = results.reduce((sum, r) => sum + r.sent, 0);
    expect(total).toBe(14);
    expect(new Set(mailer.sent.map((m) => m.messageId)).size).toBe(14);
    expect(mailer.sent).toHaveLength(14);
    expect(await dispatcher().tick()).toEqual(none);
  });

  it('failure for recipient X does not block recipient Y or org B', async () => {
    const a = await org();
    const y = await member(a);
    const b = await org();
    await schedule();
    const x = a.userId;
    const stub = new StubMailer(new Map([[await email(x), [550]]]), mailer);
    expect(await dispatcher(stub).tick()).toEqual({ ...none, sent: 2, failed: 1 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(
      [await email(y), await email(b.userId)].sort(),
    );
    expect(await delivery(a, x)).toMatchObject({ state: 'failed', last_error_code: 'smtp_550' });
  });

  it('member removed between creation and send → cancelled, nothing sent', async () => {
    const a = await org('removed-a');
    const b = await org('removed-b');
    const u = await member(a);
    await member(b, 'admin', u);
    await schedule();
    const inB = await delivery(b, u);
    expect(inB).toMatchObject({ state: 'pending' });
    await h.c.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      b.organizationId,
      u,
    ]);
    expect(await dispatcher().tick()).toEqual({ ...none, sent: 3 });
    const uEmail = await email(u);
    const uMail = mailer.sent.filter((m) => m.to === uEmail);
    expect(uMail).toHaveLength(1);
    expect(uMail[0]!.subject).toContain('Org removed-a');
    expect(JSON.stringify(uMail)).not.toContain('removed-b');
    const left = await h.c.query('SELECT 1 FROM weekly_report_delivery WHERE id = $1', [inB.id]);
    expect(left.rowCount).toBe(0);
  });

  it('demoted to member → cancelled not_recipient', async () => {
    const t = await org();
    const demoted = await member(t);
    const unverified = await member(t);
    await schedule();
    await h.c.query(
      "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [t.organizationId, demoted],
    );
    await h.c.query('UPDATE app_user SET email_verified = false WHERE id = $1', [unverified]);
    expect(await dispatcher().tick()).toEqual({ ...none, sent: 1, cancelled: 2 });
    for (const u of [demoted, unverified]) {
      expect(await delivery(t, u)).toMatchObject({
        state: 'cancelled',
        last_error_code: 'not_recipient',
        lease_until: null,
      });
    }
    expect(mailer.sent.map((m) => m.to)).toEqual([await email(t.userId)]);
  });

  it('unsubscribed via link before send → cancelled', async () => {
    const t = await org();
    const raced = await member(t);
    await schedule();
    await subs.unsubscribeByToken(await subs.ensureToken(h.c, t.organizationId, t.userId));
    // Unsubscribed after the delivery left pending (e.g. while claimed): the send-time check catches it.
    await subs.ensureToken(h.c, t.organizationId, raced);
    await h.c.query(
      `UPDATE report_subscription SET status = 'unsubscribed', unsubscribed_at = now()
        WHERE organization_id = $1 AND user_id = $2`,
      [t.organizationId, raced],
    );
    expect(await dispatcher().tick()).toEqual({ ...none, cancelled: 1 });
    for (const u of [t.userId, raced]) {
      expect(await delivery(t, u)).toMatchObject({
        state: 'cancelled',
        last_error_code: 'unsubscribed',
      });
    }
    expect(mailer.sent).toEqual([]);
  });

  it('email body never contains seeded comment bodies; org A email contains no org B ad or brand name', async () => {
    const a = await org('body-a');
    const b = await org('body-b');
    for (const [t, name] of [
      [a, 'Alpha launch ad'],
      [b, 'Bravo secret ad'],
    ] as const) {
      await seedAd(h.c, t, { name });
      for (let i = 0; i < 10; i++) {
        const c = await seedProcessed(h.c, t, { postedAt: MID });
        if (i < 4) await seedHide(h.c, t, c, { by: 'classifier', at: MID });
      }
    }
    await h.c.query('UPDATE comment SET body = $1', [SECRET_BODY]);
    await schedule();
    expect(await dispatcher().tick()).toEqual({ ...none, sent: 2 });
    const all = JSON.stringify(mailer.sent);
    expect(all).not.toContain(SECRET_BODY);
    expect(all).not.toContain('seeded comment');
    const toA = mailer.lastTo(await email(a.userId))!;
    expect(toA.html).toContain('Alpha launch ad');
    expect(toA.text).toContain('Alpha launch ad');
    expect(JSON.stringify(toA)).not.toContain('Bravo');
    expect(JSON.stringify(toA)).not.toContain('body-b');
  });

  it('log lines contain no email address', async () => {
    const t = await org();
    const failed = await member(t);
    const retried = await member(t);
    const cancelled = await member(t);
    await schedule();
    await h.c.query(
      "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [t.organizationId, cancelled],
    );
    const stub = new StubMailer(
      new Map([
        [await email(failed), [550]],
        [await email(retried), [421]],
      ]),
      mailer,
    );
    expect(await dispatcher(stub).tick()).toEqual({
      ...none,
      sent: 1,
      failed: 1,
      retried: 1,
      cancelled: 1,
    });
    expect(logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(logs).toContainEqual({
      msg: 'reports.delivery_failed',
      fields: {
        deliveryId: (await delivery(t, failed)).id,
        organizationId: t.organizationId,
        code: 'smtp_550',
      },
    });
  });
});
