import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { testKeyring } from '@feedbouncer/secrets/testing';
import type { Logger, LogFields } from '@feedbouncer/service-runtime';
import { PgAlertChannels } from './channels.js';
import { AlertDispatcher } from './dispatcher.js';
import { createAlertEvent, type AlertPayload } from './events.js';
import { slackHttp } from './slack.js';
import { enableRoute, seedFlags, seedNegativeComments } from './testing.js';

const web = new URL('https://app.example.test');
const SECRET_BODY = 'sentinel excerpt text about refunds';
const MIN = 60_000;

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let channels: PgAlertChannels;
let t: Tenant;
let now: Date;
let mailer: MemoryMailer;
let logs: { level: string; msg: string; fields?: LogFields }[];
let seq = 0;
let label: string;

const log: Logger = {
  debug: (msg, fields) => logs.push({ level: 'debug', msg, ...(fields && { fields }) }),
  info: (msg, fields) => logs.push({ level: 'info', msg, ...(fields && { fields }) }),
  warn: (msg, fields) => logs.push({ level: 'warn', msg, ...(fields && { fields }) }),
  error: (msg, fields) => logs.push({ level: 'error', msg, ...(fields && { fields }) }),
};

const hookUrl = () =>
  `https://hooks.slack.com/services/TABC${String(++seq).padStart(5, '0')}/BXYZ98765/sentinelHookSecret${String(seq).padStart(4, '0')}`;
const urls: string[] = [];

type Reply = [status: number, body?: string, headers?: Record<string, string>];
let replies: Reply[];
const fetchMock = vi.fn<typeof fetch>(() => {
  const [status, body = 'ok', headers = {}] = replies.shift() ?? [200, 'ok'];
  return Promise.resolve(new Response(body, { status, headers }));
});

beforeAll(async () => {
  h = await migratedDb();
  pool = createPool(h.db.url, { applicationName: 'alerts-test', onIdleError: () => {} });
  channels = new PgAlertChannels(pool, testKeyring(['k1']), () => now);
});
afterAll(async () => {
  await pool.end();
  await h.close();
});
beforeEach(async () => {
  await h.c.query('DELETE FROM alert_event');
  await h.c.query('DELETE FROM alert_channel');
  label = `d${++seq}`;
  t = await seedTenant(h.c, label);
  now = new Date(Date.now() + 10 * MIN);
  mailer = new MemoryMailer();
  logs = [];
  replies = [];
  urls.length = 0;
  fetchMock.mockClear();
});

const dispatcher = (o: Partial<ConstructorParameters<typeof AlertDispatcher>[0]> = {}) =>
  new AlertDispatcher({
    pool,
    log,
    channels,
    web,
    enabled: { slack: true, email: true },
    mailer,
    slackHttp: slackHttp(fetchMock),
    emailPerMinute: 60,
    now: () => now,
    ...o,
  });

async function slackChannel(tenant = t): Promise<string> {
  const url = hookUrl();
  urls.push(url);
  const r = await channels.createSlack(tenant.organizationId, tenant.userId, {
    label: 'Ops',
    webhookUrl: url,
  });
  if (r.status !== 'created') throw new Error(r.status);
  return r.channel.id;
}

async function emailChannel(tenant = t): Promise<string> {
  const r = await channels.createEmail(tenant.organizationId, tenant.userId, {
    email: `r${++seq}@example.test`,
  });
  if (r.status !== 'created') throw new Error(r.status);
  await channels.confirm(r.confirmToken);
  return r.channel.id;
}

async function spikeEvent(channelIds: string[], tenant = t): Promise<string> {
  const ids = await seedNegativeComments(h.c, tenant, { count: 4, postedAt: now });
  await h.c.query('UPDATE comment SET body = $2 WHERE id = ANY($1::uuid[])', [ids, SECRET_BODY]);
  for (const c of channelIds) await enableRoute(h.c, tenant, 'negative_spike', c);
  const payload: AlertPayload = {
    kind: 'spike',
    negatives: 4,
    total: 10,
    expectedPerHour: 2,
    trigger: 'volume',
    sensitivity: 'medium',
    minCount: 3,
    commentIds: ids,
    connectionIds: [tenant.connectionId],
    connectionCount: 1,
  };
  const r = await createAlertEvent(
    h.c,
    {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      type: 'negative_spike',
      key: `spike:${randomUUID()}`,
      windowStart: new Date(now.getTime() - 60 * MIN),
      windowEnd: now,
      payload,
    },
    { capPerHour: 100, routeType: 'negative_spike', now },
  );
  if (r.status !== 'created') throw new Error('not created');
  return r.eventId;
}

interface DeliveryRow {
  id: string;
  channel_id: string;
  state: string;
  attempts: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  sent_at: Date | null;
}
const deliveries = async (eventId?: string): Promise<DeliveryRow[]> =>
  (
    await h.c.query<DeliveryRow>(
      `SELECT id, channel_id, state, attempts, next_attempt_at, last_error_code, sent_at
         FROM alert_delivery WHERE organization_id = $1 AND ($2::uuid IS NULL OR alert_event_id = $2)
        ORDER BY created_at, id`,
      [t.organizationId, eventId ?? null],
    )
  ).rows;
const channelRow = async (id: string) =>
  (await h.c.query('SELECT * FROM alert_channel WHERE id = $1', [id])).rows[0];
const forChannel = async (channelId: string) =>
  (await deliveries()).filter((d) => d.channel_id === channelId);

describe('AlertDispatcher', () => {
  it('slack and email both receive one spike alert; email has List-Unsubscribe headers and messageId', async () => {
    const s = await slackChannel();
    const e = await emailChannel();
    const eventId = await spikeEvent([s, e]);
    expect(await dispatcher().tick()).toEqual({ sent: 2, retried: 0, failed: 0, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(urls[0]);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.subject).toBe(`Negative comment spike on Brand ${label}`);
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/app\.example\.test\//);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [dEmail] = (await deliveries(eventId)).filter((d) => d.channel_id === e);
    expect(mail.messageId).toBe(`<${dEmail!.id}@app.example.test>`);
    expect((await deliveries(eventId)).map((d) => d.state)).toEqual(['sent', 'sent']);
    expect((await channelRow(s)).last_success_at).not.toBeNull();
  });

  it('slack 503 three times then ok → sent on attempt 4 with delays 30s, 2m, 10m; email delivered on the first tick regardless', async () => {
    const s = await slackChannel();
    const e = await emailChannel();
    const eventId = await spikeEvent([s, e]);
    replies = [
      [503, ''],
      [503, ''],
      [503, ''],
    ];
    const d = dispatcher();
    expect(await d.tick()).toMatchObject({ sent: 1, retried: 1 });
    expect(mailer.sent).toHaveLength(1);
    const slackDelivery = async () => (await forChannel(s))[0]!;
    for (const [attempts, delay] of [
      [1, 30_000],
      [2, 120_000],
      [3, 600_000],
    ] as const) {
      const row = await slackDelivery();
      expect(row).toMatchObject({ state: 'retrying', attempts, last_error_code: 'http_503' });
      expect(row.next_attempt_at.getTime()).toBe(now.getTime() + delay);
      now = new Date(now.getTime() + delay - 1);
      await d.tick();
      expect((await slackDelivery()).attempts).toBe(attempts);
      now = new Date(now.getTime() + 1);
      await d.tick();
    }
    expect(await slackDelivery()).toMatchObject({ state: 'sent', attempts: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mailer.sent).toHaveLength(1);
    expect((await deliveries(eventId)).every((x) => x.state === 'sent')).toBe(true);
  });

  it('email SMTP 451 → retrying; 550 → failed and channel health delivery_problem; Slack unaffected', async () => {
    const s = await slackChannel();
    const e = await emailChannel();
    await spikeEvent([s, e]);
    const smtp = (responseCode: number) =>
      Object.assign(new Error('smtp send failed'), { cause: { responseCode } });
    const send = vi.spyOn(mailer, 'send').mockRejectedValueOnce(smtp(451));
    const d = dispatcher();
    expect(await d.tick()).toEqual({ sent: 1, retried: 1, failed: 0, skipped: 0 });
    expect(await forChannel(e)).toMatchObject([{ state: 'retrying', last_error_code: 'smtp_451' }]);
    expect((await forChannel(s))[0]!.state).toBe('sent');

    send.mockRejectedValueOnce(smtp(550));
    now = new Date(now.getTime() + 31_000);
    expect(await d.tick()).toMatchObject({ failed: 1 });
    expect(await forChannel(e)).toMatchObject([{ state: 'failed', last_error_code: 'smtp_550' }]);
    expect((await channels.get(t.organizationId, e))?.health).toBe('delivery_problem');
    expect((await channels.get(t.organizationId, s))?.health).toBe('active');
  });

  it('six transient failures → failed retries_exhausted, consecutive_failures 6', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    replies = Array.from({ length: 6 }, () => [500, 'x'] as Reply);
    const d = dispatcher();
    for (let i = 0; i < 6; i++) {
      await d.tick();
      now = new Date(now.getTime() + 2 * 3_600_000 + MIN);
    }
    expect(await forChannel(s)).toMatchObject([
      { state: 'failed', attempts: 6, last_error_code: 'retries_exhausted' },
    ]);
    expect((await channelRow(s)).consecutive_failures).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('429 Retry-After 120 → next_attempt_at ≥ now + 120s', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    replies = [[429, 'rate_limited', { 'retry-after': '120' }]];
    expect(await dispatcher().tick()).toMatchObject({ retried: 1 });
    const [row] = await forChannel(s);
    expect(row).toMatchObject({ state: 'retrying', last_error_code: 'rate_limited' });
    expect(row!.next_attempt_at.getTime()).toBeGreaterThanOrEqual(now.getTime() + 120_000);
  });

  it('revoked webhook (404 no_service) → channel disconnected, other pending deliveries cancelled, owners and admins emailed once, no further fetch calls on later ticks', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    await spikeEvent([]);
    const adminId = (
      await h.c.query<{ id: string }>('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
        `admin-${randomUUID()}@example.test`,
      ])
    ).rows[0]!.id;
    const memberId = (
      await h.c.query<{ id: string }>('INSERT INTO app_user (email) VALUES ($1) RETURNING id', [
        `member-${randomUUID()}@example.test`,
      ])
    ).rows[0]!.id;
    await h.c.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')",
      [t.organizationId, adminId, memberId],
    );
    replies = [[404, 'no_service']];
    const d = dispatcher();
    expect(await d.tick()).toMatchObject({ failed: 1 });
    expect(await channels.get(t.organizationId, s)).toMatchObject({
      status: 'disconnected',
      disconnectedCode: 'no_service',
    });
    const states = (await forChannel(s)).map((x) => x.state).sort();
    expect(states).toEqual(['cancelled', 'failed']);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent.every((m) => m.subject.startsWith('Slack alerts disconnected'))).toBe(true);
    const audit = await h.c.query(
      "SELECT actor_type, details FROM audit_event WHERE organization_id = $1 AND action = 'alert.channel_disconnected'",
      [t.organizationId],
    );
    expect(audit.rows).toEqual([{ actor_type: 'system', details: { code: 'no_service' } }]);
    now = new Date(now.getTime() + 10 * MIN);
    await d.tick();
    await d.tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it('two deliveries to one Slack channel in one tick → only one sent; second sent ≥ 1 s later', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    await spikeEvent([]);
    const d = dispatcher();
    expect(await d.tick()).toMatchObject({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await d.tick()).toMatchObject({ sent: 0 });
    now = new Date(now.getTime() + 999);
    expect(await d.tick()).toMatchObject({ sent: 0 });
    now = new Date(now.getTime() + 1);
    expect(await d.tick()).toMatchObject({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expired sending lease → failed outcome_unknown, no resend', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    await h.c.query(
      `UPDATE alert_delivery SET state = 'sending', attempts = 1, lease_until = $2 WHERE organization_id = $1`,
      [t.organizationId, new Date(now.getTime() + 120_000)],
    );
    const d = dispatcher();
    expect(await d.tick()).toEqual({ sent: 0, retried: 0, failed: 0, skipped: 0 });
    now = new Date(now.getTime() + 3 * MIN);
    expect(await d.tick()).toMatchObject({ failed: 1 });
    expect(await forChannel(s)).toMatchObject([
      { state: 'failed', last_error_code: 'outcome_unknown' },
    ]);
    expect((await channelRow(s)).consecutive_failures).toBe(1);
    now = new Date(now.getTime() + 3 * MIN);
    await d.tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('two dispatchers in parallel → one send per delivery', async () => {
    const chans = await Promise.all(Array.from({ length: 6 }, () => slackChannel()));
    await spikeEvent(chans);
    const [x, y] = [dispatcher(), dispatcher()];
    const results = await Promise.all([x.tick(), y.tick()]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(new Set(fetchMock.mock.calls.map((c) => String(c[0]))).size).toBe(6);
  });

  it('items resolved after digest, before send → delivery skipped', async () => {
    const s = await slackChannel();
    const ids = await seedFlags(h.c, t, { count: 2, createdAt: now });
    await enableRoute(h.c, t, 'flagged_item', s);
    await createAlertEvent(
      h.c,
      {
        organizationId: t.organizationId,
        brandId: t.brandId,
        type: 'flagged_digest',
        key: `flags:${randomUUID()}`,
        windowStart: now,
        windowEnd: now,
        payload: { kind: 'flags', reviewItemIds: ids, count: 2 },
      },
      { capPerHour: 100, routeType: 'flagged_item', now },
    );
    await h.c.query(
      "UPDATE review_item SET status = 'resolved', resolution = 'approved', resolved_at = now() WHERE id = ANY($1::uuid[])",
      [ids],
    );
    expect(await dispatcher().tick()).toEqual({ sent: 0, retried: 0, failed: 0, skipped: 1 });
    expect(await forChannel(s)).toMatchObject([
      { state: 'skipped', last_error_code: 'all_resolved' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('archived brand before send → skipped', async () => {
    const s = await slackChannel();
    await spikeEvent([s]);
    await h.c.query('UPDATE brand SET archived_at = now() WHERE id = $1', [t.brandId]);
    expect(await dispatcher().tick()).toMatchObject({ skipped: 1, sent: 0 });
    expect((await forChannel(s))[0]!.state).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emailPerMinute 2 with 5 email deliveries → 2 sent this tick, rest later', async () => {
    const chans = await Promise.all(Array.from({ length: 5 }, () => emailChannel()));
    await spikeEvent(chans);
    const d = dispatcher({ emailPerMinute: 2 });
    expect(await d.tick()).toMatchObject({ sent: 2 });
    expect(await d.tick()).toMatchObject({ sent: 0 });
    now = new Date(now.getTime() + 61_000);
    expect(await d.tick()).toMatchObject({ sent: 2 });
    now = new Date(now.getTime() + 61_000);
    expect(await d.tick()).toMatchObject({ sent: 1 });
    expect(mailer.sent).toHaveLength(5);
  });

  it('enabled.email false → email deliveries cancelled, no errors logged', async () => {
    const e = await emailChannel();
    await spikeEvent([e]);
    expect(await dispatcher({ enabled: { slack: true, email: false } }).tick()).toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
    });
    expect((await forChannel(e))[0]!.state).toBe('cancelled');
    expect(mailer.sent).toHaveLength(0);
    expect(logs.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('logs contain no webhook URL, email address or excerpt text', async () => {
    const s = await slackChannel();
    const e = await emailChannel();
    await spikeEvent([s, e]);
    vi.spyOn(mailer, 'send').mockRejectedValue(new Error('rejected r1@example.test'));
    replies = [[404, 'no_service']];
    const d = dispatcher();
    await d.tick();
    now = new Date(now.getTime() + 10 * MIN);
    await d.tick();
    expect(logs.some((l) => l.msg === 'alerts.disconnect_notify_failed')).toBe(true);
    expect(logs.some((l) => l.msg === 'alerts.dispatch')).toBe(true);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('hooks.slack.com');
    expect(text).not.toContain('sentinelHookSecret');
    expect(text).not.toContain('@example.test');
    expect(text).not.toContain(SECRET_BODY);
    const first = logs.find((l) => l.msg === 'alerts.dispatch')!;
    expect(Object.keys(first.fields!).sort()).toEqual([
      'attempt',
      'channelKind',
      'code',
      'deliveryId',
      'outcome',
    ]);
  });

  describe('sendTest', () => {
    it('ok posts the test message and creates no delivery', async () => {
      const s = await slackChannel();
      await expect(dispatcher().sendTest(t.organizationId, s)).resolves.toEqual({ ok: true });
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).text).toBe(
        'FeedBouncer test alert: this channel is connected.',
      );
      const e = await emailChannel();
      await expect(dispatcher().sendTest(t.organizationId, e)).resolves.toEqual({ ok: true });
      expect(mailer.sent).toHaveLength(1);
      expect(await deliveries()).toEqual([]);
    });

    it('revoked → disconnected and admins notified', async () => {
      const s = await slackChannel();
      replies = [[404, 'channel_not_found']];
      await expect(dispatcher().sendTest(t.organizationId, s)).resolves.toEqual({
        ok: false,
        code: 'channel_not_found',
      });
      expect(await channels.get(t.organizationId, s)).toMatchObject({ status: 'disconnected' });
      expect(mailer.sent).toHaveLength(1);
    });

    it('unconfirmed email → not_confirmed; other tenants cannot be tested', async () => {
      const r = await channels.createEmail(t.organizationId, t.userId, {
        email: 'pending@example.test',
      });
      if (r.status !== 'created') throw new Error(r.status);
      await expect(dispatcher().sendTest(t.organizationId, r.channel.id)).resolves.toEqual({
        ok: false,
        code: 'not_confirmed',
      });
      const other = await seedTenant(h.c, `o${++seq}`);
      const s = await slackChannel();
      await expect(dispatcher().sendTest(other.organizationId, s)).resolves.toEqual({
        ok: false,
        code: 'not_found',
      });
      expect(mailer.sent).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
