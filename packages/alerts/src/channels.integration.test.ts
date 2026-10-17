import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { PgAlertChannels } from './channels.js';

const URL_A = 'https://hooks.slack.com/services/TABC12345/BXYZ98765/sentinelHookSecret1234';
const URL_B = 'https://hooks.slack.com/services/TDEF67890/BQRS43210/otherHookSecret56789';
let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let a: Tenant;
let b: Tenant;
let now = new Date('2030-01-01T00:00:00Z');
let channels: PgAlertChannels;

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
  a = await seedTenant(h.c, 'a');
  b = await seedTenant(h.c, 'b');
  channels = new PgAlertChannels(pool, testKeyring(['k1']), () => now);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

const sha = (s: string) => createHash('sha256').update(s).digest();
const row = async (id: string) =>
  (await h.c.query('SELECT * FROM alert_channel WHERE id = $1', [id])).rows[0];
const email = async (e: string, org = a) => {
  const r = await channels.createEmail(org.organizationId, org.userId, { email: e });
  if (r.status !== 'created') throw new Error(r.status);
  return r;
};

describe('slack channels', () => {
  it('stores only ciphertext (no URL substring in any column) and round-trips', async () => {
    const r = await channels.createSlack(a.organizationId, a.userId, {
      label: 'Ops',
      webhookUrl: URL_A,
    });
    if (r.status !== 'created') throw new Error(r.status);
    expect(r.channel).toMatchObject({
      kind: 'slack',
      status: 'active',
      health: 'active',
      hint: 'T…2345/B…8765',
    });
    expect(JSON.stringify(r.channel)).not.toContain('sentinelHookSecret');
    const raw = JSON.stringify(
      (
        await h.c.query('SELECT row_to_json(c)::text AS j FROM alert_channel c WHERE id = $1', [
          r.channel.id,
        ])
      ).rows[0].j,
    );
    expect(raw).not.toContain('sentinelHookSecret');
    expect(raw).not.toContain('hooks.slack.com');
    expect((await channels.openWebhookUrl(a.organizationId, r.channel.id))?.href).toBe(URL_A);
    expect(await channels.openWebhookUrl(b.organizationId, r.channel.id)).toBeNull();
  });

  it('rejects invalid webhook URLs and reconnects with a new one', async () => {
    expect(
      await channels.createSlack(a.organizationId, a.userId, {
        label: 'x',
        webhookUrl: 'https://evil.io/services/T00/B00/abc',
      }),
    ).toEqual({ status: 'invalid_webhook_url' });
    const r = await channels.createSlack(a.organizationId, a.userId, {
      label: 'Re',
      webhookUrl: URL_A,
    });
    if (r.status !== 'created') throw new Error(r.status);
    await h.c.query(
      "UPDATE alert_channel SET status = 'disconnected', disconnected_code = 'webhook_revoked' WHERE id = $1",
      [r.channel.id],
    );
    expect(
      await channels.reconnectSlack(a.organizationId, a.userId, r.channel.id, 'http://nope'),
    ).toEqual({ status: 'invalid_webhook_url' });
    expect(await channels.reconnectSlack(b.organizationId, b.userId, r.channel.id, URL_B)).toEqual({
      status: 'not_found',
    });
    const ok = await channels.reconnectSlack(a.organizationId, a.userId, r.channel.id, URL_B);
    expect(ok).toMatchObject({
      status: 'ok',
      channel: { status: 'active', disconnectedCode: null, hint: 'T…7890/B…3210' },
    });
    expect((await channels.openWebhookUrl(a.organizationId, r.channel.id))?.href).toBe(URL_B);
  });

  it('markDisconnected flips active channels once', async () => {
    const r = await channels.createSlack(a.organizationId, a.userId, {
      label: 'Md',
      webhookUrl: URL_A,
    });
    if (r.status !== 'created') throw new Error(r.status);
    expect(
      await channels.markDisconnected(h.c, a.organizationId, r.channel.id, 'webhook_revoked'),
    ).toBe(true);
    expect(
      await channels.markDisconnected(h.c, a.organizationId, r.channel.id, 'webhook_revoked'),
    ).toBe(false);
    expect(await channels.get(a.organizationId, r.channel.id)).toMatchObject({
      status: 'disconnected',
      disconnectedCode: 'webhook_revoked',
    });
    const ev = await h.c.query(
      "SELECT actor_type, details FROM audit_event WHERE action = 'alert.channel_disconnected' AND subject_id = $1",
      [r.channel.id],
    );
    expect(ev.rows).toEqual([{ actor_type: 'system', details: { code: 'webhook_revoked' } }]);
  });

  it('reports delivery_problem when the last failure is newer than the last success', async () => {
    const r = await channels.createSlack(a.organizationId, a.userId, {
      label: 'Hp',
      webhookUrl: URL_A,
    });
    if (r.status !== 'created') throw new Error(r.status);
    await h.c.query(
      "UPDATE alert_channel SET last_failure_at = now(), last_failure_code = 'http_500' WHERE id = $1",
      [r.channel.id],
    );
    expect(await channels.get(a.organizationId, r.channel.id)).toMatchObject({
      health: 'delivery_problem',
      lastFailureCode: 'http_500',
    });
  });
});

describe('email channels', () => {
  it('pending → confirm → active; reused and expired tokens are invalid', async () => {
    const r = await email('Ann@Example.com');
    expect(r.channel).toMatchObject({
      status: 'pending_confirmation',
      email: 'ann@example.com',
      label: 'ann@example.com',
    });
    const stored = await row(r.channel.id);
    expect(stored.confirm_key_sha256).toEqual(sha(r.confirmToken));
    expect(stored.confirm_expires_at.getTime()).toBe(now.getTime() + 7 * 86_400_000);
    expect(await channels.confirm(r.confirmToken)).toEqual({
      status: 'confirmed',
      organizationId: a.organizationId,
    });
    expect(await channels.get(a.organizationId, r.channel.id)).toMatchObject({ status: 'active' });
    expect(await channels.confirm(r.confirmToken)).toEqual({ status: 'invalid' });

    const late = await email('late@example.com');
    const saved = now;
    now = new Date(saved.getTime() + 7 * 86_400_000 + 1000);
    expect(await channels.confirm(late.confirmToken)).toEqual({ status: 'invalid' });
    now = saved;
    expect(await channels.confirm('garbage')).toEqual({ status: 'invalid' });
  });

  it('rejects bad and duplicate addresses (case variants)', async () => {
    await email('dup@example.com');
    expect(
      await channels.createEmail(a.organizationId, a.userId, { email: 'DUP@example.com' }),
    ).toEqual({ status: 'email_taken' });
    expect(await channels.createEmail(a.organizationId, a.userId, { email: 'a@b,c@d' })).toEqual({
      status: 'invalid_email',
    });
    expect(
      (await channels.createEmail(b.organizationId, b.userId, { email: 'dup@example.com' })).status,
    ).toBe('created');
  });

  it('openUnsubscribeToken is stable; unsubscribe works once then reports already', async () => {
    const r = await email('stable@example.com');
    const t1 = await channels.openUnsubscribeToken(a.organizationId, r.channel.id);
    expect(t1).toBeTruthy();
    expect(await channels.openUnsubscribeToken(a.organizationId, r.channel.id)).toBe(t1);
    expect(await channels.openUnsubscribeToken(b.organizationId, r.channel.id)).toBeNull();
    expect(await channels.unsubscribe(t1!)).toEqual({ status: 'unsubscribed' });
    expect(await channels.unsubscribe(t1!)).toEqual({ status: 'already' });
    expect(await channels.unsubscribe('garbage')).toEqual({ status: 'invalid' });
    expect(await channels.get(a.organizationId, r.channel.id)).toMatchObject({
      status: 'unsubscribed',
    });
  });

  it('unsubscribe cancels pending and retrying deliveries only', async () => {
    const r = await email('cancel@example.com');
    const ev = (
      await h.c.query(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', 'k1', 'queued', '{}') RETURNING id`,
        [a.organizationId, a.brandId],
      )
    ).rows[0].id;
    const ev2 = (
      await h.c.query(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', 'k2', 'queued', '{}') RETURNING id`,
        [a.organizationId, a.brandId],
      )
    ).rows[0].id;
    const ev3 = (
      await h.c.query(
        `INSERT INTO alert_event (organization_id, brand_id, alert_type, alert_key, status, payload)
         VALUES ($1, $2, 'negative_spike', 'k3', 'queued', '{}') RETURNING id`,
        [a.organizationId, a.brandId],
      )
    ).rows[0].id;
    for (const [e, s] of [
      [ev, 'pending'],
      [ev2, 'retrying'],
      [ev3, 'sent'],
    ]) {
      await h.c.query(
        'INSERT INTO alert_delivery (organization_id, alert_event_id, channel_id, state) VALUES ($1, $2, $3, $4)',
        [a.organizationId, e, r.channel.id, s],
      );
    }
    const tok = (await channels.openUnsubscribeToken(a.organizationId, r.channel.id))!;
    await channels.unsubscribe(tok);
    const states = await h.c.query(
      'SELECT state FROM alert_delivery WHERE channel_id = $1 ORDER BY state',
      [r.channel.id],
    );
    expect(states.rows.map((x) => x.state)).toEqual(['cancelled', 'cancelled', 'sent']);
  });

  it('rotateConfirmation on unsubscribed → pending with a new unsubscribe token; old token invalid', async () => {
    const r = await email('rot@example.com');
    expect(await channels.rotateConfirmation(b.organizationId, r.channel.id)).toBeNull();
    const old = (await channels.openUnsubscribeToken(a.organizationId, r.channel.id))!;
    await channels.confirm(r.confirmToken);
    expect(await channels.rotateConfirmation(a.organizationId, r.channel.id)).toBeNull();
    await channels.unsubscribe(old);
    const rot = await channels.rotateConfirmation(a.organizationId, r.channel.id);
    expect(rot?.email).toBe('rot@example.com');
    expect(await channels.get(a.organizationId, r.channel.id)).toMatchObject({
      status: 'pending_confirmation',
    });
    const fresh = await channels.openUnsubscribeToken(a.organizationId, r.channel.id);
    expect(fresh).not.toBe(old);
    expect(await channels.unsubscribe(old)).toEqual({ status: 'invalid' });
    expect(await channels.confirm(rot!.confirmToken)).toMatchObject({ status: 'confirmed' });
  });

  it('rotateConfirmation on pending replaces the confirm token and keeps the unsubscribe token', async () => {
    const r = await email('pend@example.com');
    const before = await channels.openUnsubscribeToken(a.organizationId, r.channel.id);
    const rot = await channels.rotateConfirmation(a.organizationId, r.channel.id);
    expect(rot!.confirmToken).not.toBe(r.confirmToken);
    expect(await channels.openUnsubscribeToken(a.organizationId, r.channel.id)).toBe(before);
    expect(await channels.confirm(r.confirmToken)).toEqual({ status: 'invalid' });
  });
});

describe('tenancy, removal and audit', () => {
  it('list never shows org B channels and remove is org-scoped', async () => {
    const rb = await channels.createSlack(b.organizationId, b.userId, {
      label: 'B only',
      webhookUrl: URL_B,
    });
    if (rb.status !== 'created') throw new Error(rb.status);
    expect((await channels.list(a.organizationId)).map((c) => c.id)).not.toContain(rb.channel.id);
    expect(await channels.get(a.organizationId, rb.channel.id)).toBeNull();
    expect(await channels.remove(a.organizationId, a.userId, rb.channel.id)).toBe(false);
    expect(await channels.remove(b.organizationId, b.userId, rb.channel.id)).toBe(true);
    expect(await channels.remove(b.organizationId, b.userId, rb.channel.id)).toBe(false);
  });

  it('audit details never contain the URL, email or tokens', async () => {
    const res = await h.c.query(
      "SELECT action, actor_type, details::text AS d FROM audit_event WHERE action LIKE 'alert.%'",
    );
    const actions = new Set(res.rows.map((x) => x.action));
    for (const x of [
      'alert.channel_created',
      'alert.channel_reconnected',
      'alert.channel_deleted',
      'alert.recipient_confirmed',
      'alert.recipient_unsubscribed',
    ])
      expect(actions).toContain(x);
    const all = res.rows.map((x) => x.d).join('\n');
    for (const s of ['hooks.slack.com', 'sentinelHookSecret', '@example.com', 'https://'])
      expect(all).not.toContain(s);
    expect(
      res.rows
        .filter((x) => x.action === 'alert.recipient_confirmed')
        .every((x) => x.actor_type === 'system'),
    ).toBe(true);
  });
});
