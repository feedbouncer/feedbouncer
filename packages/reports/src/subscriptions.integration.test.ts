import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { PgReportSubscriptions } from './subscriptions.js';

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let subs: PgReportSubscriptions;
let n = 0;
const NOW = new Date('2026-10-19T08:00:00Z');

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'reports-test', onIdleError: () => {} });
  subs = new PgReportSubscriptions(pool, testKeyring(['k1']), () => NOW);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const fresh = (label = `sub${++n}`) => seedTenant(h.c, label);
const token = (t: Tenant, userId = t.userId) => subs.ensureToken(h.c, t.organizationId, userId);

async function addMember(t: Tenant, role: 'owner' | 'admin' | 'member', userId?: string) {
  const id =
    userId ??
    (
      await h.c.query<{ id: string }>('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
        `m-${uuid()}@example.test`,
      ])
    ).rows[0]!.id;
  await h.c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
    t.organizationId,
    id,
    role,
  ]);
  return id;
}

let weeks = 0;
async function seedDelivery(t: Tenant, userId: string, state = 'pending') {
  const report = await h.c.query<{ id: string }>(
    `INSERT INTO weekly_report (organization_id, week_start, timezone, period_start, period_end, status, payload,
       computed_at)
     SELECT $1, w, 'UTC', w, w + 7, 'queued', '{}', now() FROM (SELECT '2026-01-05'::date + 7 * $2::int AS w) x
     RETURNING id`,
    [t.organizationId, weeks++],
  );
  return (
    await h.c.query<{ id: string }>(
      `INSERT INTO weekly_report_delivery (organization_id, report_id, user_id, state)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [t.organizationId, report.rows[0]!.id, userId, state],
    )
  ).rows[0]!.id;
}

const delivery = async (id: string) =>
  (await h.c.query('SELECT state, last_error_code FROM weekly_report_delivery WHERE id = $1', [id]))
    .rows[0];

const audits = async (t: Tenant) =>
  (
    await h.c.query(
      `SELECT actor_type, actor_user_id, action, subject_type, details FROM audit_event
        WHERE organization_id = $1 AND action LIKE 'report.%' ORDER BY created_at, id`,
      [t.organizationId],
    )
  ).rows;

describe('PgReportSubscriptions', () => {
  it('ensureToken is stable across calls and stores only ciphertext + sha256 (no token substring in any column)', async () => {
    const t = await fresh();
    const first = await token(t);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await token(t)).toBe(first);
    const rows = await h.c.query(
      `SELECT row_to_json(s)::text AS j, encode(unsubscribe_key_sha256, 'hex') AS sha,
              encode(encrypted_unsubscribe_token, 'escape') AS blob, status
         FROM report_subscription s WHERE organization_id = $1`,
      [t.organizationId],
    );
    expect(rows.rows).toHaveLength(1);
    const r = rows.rows[0];
    expect(r.status).toBe('subscribed');
    expect(r.j).not.toContain(first);
    expect(r.blob).not.toContain(first);
    expect(r.sha).toBe(createHash('sha256').update(first).digest('hex'));
  });

  it('unsubscribeByToken → unsubscribed, again → already, garbage/short token → invalid', async () => {
    const t = await fresh();
    const tk = await token(t);
    expect(await subs.unsubscribeByToken(tk)).toEqual({ status: 'unsubscribed' });
    expect(await subs.unsubscribeByToken(tk)).toEqual({ status: 'already' });
    expect(await subs.unsubscribeByToken('short')).toEqual({ status: 'invalid' });
    expect(await subs.unsubscribeByToken(`${'a'.repeat(42)}!`)).toEqual({ status: 'invalid' });
    expect(await subs.unsubscribeByToken('b'.repeat(43))).toEqual({ status: 'invalid' });
    const row = (
      await h.c.query(
        'SELECT status, unsubscribed_at FROM report_subscription WHERE organization_id = $1',
        [t.organizationId],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'unsubscribed', unsubscribed_at: NOW });
    expect(await audits(t)).toEqual([
      {
        actor_type: 'system',
        actor_user_id: null,
        action: 'report.unsubscribed',
        subject_type: 'report_subscription',
        details: {},
      },
    ]);
  });

  it('unsubscribe cancels pending deliveries of that user in that org only (org B delivery untouched)', async () => {
    const a = await fresh();
    const b = await fresh();
    const other = await addMember(a, 'admin');
    await addMember(b, 'admin', a.userId);
    const pending = await seedDelivery(a, a.userId);
    const retrying = await seedDelivery(a, a.userId, 'retrying');
    const sent = await seedDelivery(a, a.userId, 'sent');
    const theirs = await seedDelivery(a, other);
    const inB = await seedDelivery(b, a.userId);
    expect(await subs.unsubscribeByToken(await token(a))).toEqual({ status: 'unsubscribed' });
    const cancelled = { state: 'cancelled', last_error_code: 'unsubscribed' };
    expect(await delivery(pending)).toEqual(cancelled);
    expect(await delivery(retrying)).toEqual(cancelled);
    expect(await delivery(sent)).toEqual({ state: 'sent', last_error_code: null });
    expect(await delivery(theirs)).toEqual({ state: 'pending', last_error_code: null });
    expect(await delivery(inB)).toEqual({ state: 'pending', last_error_code: null });
  });

  it('listForUser hides orgs where user is member', async () => {
    const a = await fresh('list-a');
    const b = await fresh('list-b');
    const c = await fresh('list-c');
    await addMember(b, 'admin', a.userId);
    await addMember(c, 'member', a.userId);
    await subs.unsubscribeByToken(await token(b, a.userId));
    const list = await subs.listForUser(a.userId);
    expect(list).toEqual([
      {
        organizationId: a.organizationId,
        organizationName: 'Org list-a',
        subscribed: true,
      },
      {
        organizationId: b.organizationId,
        organizationName: 'Org list-b',
        subscribed: false,
      },
    ]);
  });

  it('setForUser on org where user is a plain member → not_found', async () => {
    const a = await fresh();
    const member = await addMember(a, 'member');
    const stranger = (await fresh()).userId;
    expect(await subs.setForUser(member, a.organizationId, false)).toEqual({ status: 'not_found' });
    expect(await subs.setForUser(stranger, a.organizationId, false)).toEqual({
      status: 'not_found',
    });
    const rows = await h.c.query('SELECT 1 FROM report_subscription WHERE organization_id = $1', [
      a.organizationId,
    ]);
    expect(rows.rowCount).toBe(0);
    expect(await audits(a)).toEqual([]);
  });

  it('setForUser unsubscribes without an existing row and cancels pending deliveries', async () => {
    const a = await fresh();
    const d = await seedDelivery(a, a.userId);
    expect(await subs.setForUser(a.userId, a.organizationId, false)).toEqual({ status: 'ok' });
    expect(await subs.setForUser(a.userId, a.organizationId, false)).toEqual({ status: 'ok' });
    expect(await delivery(d)).toEqual({ state: 'cancelled', last_error_code: 'unsubscribed' });
    expect((await subs.listForUser(a.userId))[0]?.subscribed).toBe(false);
    expect(await audits(a)).toEqual([
      {
        actor_type: 'user',
        actor_user_id: a.userId,
        action: 'report.unsubscribed',
        subject_type: 'report_subscription',
        details: {},
      },
    ]);
  });

  it('resubscribe rotates token: old token → invalid', async () => {
    const a = await fresh();
    const old = await token(a);
    expect(await subs.setForUser(a.userId, a.organizationId, true)).toEqual({ status: 'ok' });
    expect(await token(a)).toBe(old);
    await subs.unsubscribeByToken(old);
    expect(await subs.setForUser(a.userId, a.organizationId, true)).toEqual({ status: 'ok' });
    const rotated = await token(a);
    expect(rotated).not.toBe(old);
    expect(await subs.unsubscribeByToken(old)).toEqual({ status: 'invalid' });
    expect((await subs.listForUser(a.userId))[0]?.subscribed).toBe(true);
    expect((await audits(a)).map((e) => [e.action, e.actor_type])).toEqual([
      ['report.unsubscribed', 'system'],
      ['report.resubscribed', 'user'],
    ]);
    expect(await subs.unsubscribeByToken(rotated)).toEqual({ status: 'unsubscribed' });
  });

  it('audit details contain no email or token', async () => {
    const a = await fresh();
    const tk = await token(a);
    await subs.unsubscribeByToken(tk);
    await subs.setForUser(a.userId, a.organizationId, true);
    await subs.setForUser(a.userId, a.organizationId, false);
    const email = (await h.c.query('SELECT email FROM app_user WHERE id = $1', [a.userId])).rows[0]
      .email as string;
    const rows = await h.c.query(
      "SELECT row_to_json(e)::text AS j FROM audit_event e WHERE organization_id = $1 AND action LIKE 'report.%'",
      [a.organizationId],
    );
    expect(rows.rowCount).toBe(3);
    for (const { j } of rows.rows) {
      expect(j).not.toContain(email);
      expect(j).not.toContain(tk);
    }
  });
});
