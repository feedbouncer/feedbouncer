import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Webhook } from 'standardwebhooks';
import { Registry } from '@prometheus-io/client';
import { migratedDb, seedTenant, uuid, type Tenant } from '@feedbouncer/db/testing';
import { MemoryMailer } from '@feedbouncer/mailer/testing';
import { PgApiKeys, type ApiKeyContext } from '@feedbouncer/public-api';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { createLogger, type Secret } from '@feedbouncer/service-runtime';
import {
  MAX_ATTEMPTS,
  PER_ENDPOINT_IN_FLIGHT,
  PER_ORG_IN_FLIGHT,
  RETRY_DELAYS_SECONDS,
} from './constants.js';
import { EventUnavailableError, PgWebhookDeliveries } from './deliveries.js';
import { WebhookDispatcher } from './dispatcher.js';
import { PgWebhookEndpoints } from './endpoints.js';
import { createWebhookMetrics } from './metrics.js';
import type { TransportResult, WebhookTransport } from './transport.js';

const OK: TransportResult = { ok: true, status: 204, durationMs: 7 };
const FAIL: TransportResult = { ok: false, status: 500, code: 'http_status', durationMs: 7 };
const DAY = 86_400;

interface Sent {
  url: URL;
  headers: Record<string, string>;
  body: string;
  settle(r: TransportResult): void;
}

/** Records every request; `reply` answers at once, or returns null to leave the request hanging. */
class FakeTransport implements WebhookTransport {
  readonly sent: Sent[] = [];
  reply: (url: URL) => TransportResult | null = () => OK;

  send(req: { url: URL; headers: Record<string, string>; body: string }) {
    return new Promise<TransportResult>((resolve) => {
      this.sent.push({ ...req, settle: resolve });
      const r = this.reply(req.url);
      if (r) resolve(r);
    });
  }

  to(host: string): Sent[] {
    return this.sent.filter((s) => s.url.hostname === host);
  }

  release(): void {
    for (const s of this.sent) s.settle(OK);
  }
}

let h: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let endpoints: PgWebhookEndpoints;
let deliveries: PgWebhookDeliveries;
let mailer: MemoryMailer;
let clock: Date;
let seq = 0;
const lines: Array<Record<string, unknown>> = [];
const log = createLogger('test', 'debug', (l) => lines.push(JSON.parse(l)));
const dispatchers: WebhookDispatcher[] = [];
const transports: FakeTransport[] = [];

beforeAll(async () => {
  h = await migratedDb();
  pool = new pg.Pool({ connectionString: h.db.url.href, max: 16 });
  endpoints = new PgWebhookEndpoints(pool, testKeyring(), {
    resolve: () => Promise.resolve(['93.184.216.34']),
    allowedPrivateCidrs: [],
  });
  deliveries = new PgWebhookDeliveries(pool);
});

afterEach(async () => {
  for (const t of transports.splice(0)) t.release();
  await Promise.all(dispatchers.splice(0).map((d) => d.drain()));
  await pool.query('DELETE FROM webhook_endpoint');
  lines.length = 0;
});

afterAll(async () => {
  await pool.end();
  await h.close();
});

const advance = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000));

function start(o: { random?: () => number; concurrency?: number } = {}) {
  // A little ahead of the database clock, so rows the triggers create are already due.
  clock = new Date(Date.now() + 5_000);
  mailer = new MemoryMailer();
  const transport = new FakeTransport();
  transports.push(transport);
  return { transport, d: dispatcher(transport, o) };
}

function dispatcher(
  transport: WebhookTransport,
  o: { random?: () => number; concurrency?: number } = {},
) {
  const d = new WebhookDispatcher({
    pool,
    endpoints,
    transport,
    mailer,
    log,
    metrics: createWebhookMetrics(new Registry()),
    concurrency: o.concurrency ?? 32,
    now: () => clock,
    random: o.random ?? (() => 0.5),
  });
  dispatchers.push(d);
  return d;
}

async function run(d: WebhookDispatcher, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    await d.tick();
    await d.drain();
  }
}

interface Setup {
  t: Tenant;
  ctx: ApiKeyContext;
  endpointId: string;
  secret: Secret;
}

async function setup(host = 'hooks.example.com', t?: Tenant): Promise<Setup> {
  const label = `d${++seq}`;
  t ??= await seedTenant(h.c, label);
  const { key } = await new PgApiKeys(pool).create(t.organizationId, t.userId, {
    name: label,
    scope: 'write',
  });
  const ctx: ApiKeyContext = { organizationId: t.organizationId, apiKeyId: key.id, scope: 'write' };
  const { endpoint, secret } = await endpoints.create(ctx, {
    url: `https://${host}/private/path?token=abc`,
    eventTypes: ['comment.received'],
  });
  return { t, ctx, endpointId: endpoint.id, secret };
}

async function comments(t: Tenant, n = 1): Promise<string[]> {
  const { rows } = await h.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, author_id, external_id, body, posted_at, ingest_origin)
     SELECT $1, $2, $3, $4, $5, 'c-' || gen_random_uuid(), 'hello', now(), 'live'
       FROM generate_series(1, $6) RETURNING id`,
    [t.organizationId, t.brandId, t.connectionId, t.sourceId, t.authorId, n],
  );
  return rows.map((r) => r.id);
}

async function eventOf(commentId: string): Promise<string> {
  const { rows } = await h.c.query<{ id: string }>(
    'SELECT id FROM webhook_event WHERE comment_id = $1',
    [commentId],
  );
  return rows[0]!.id;
}

async function rowsOf(endpointId: string) {
  const { rows } = await h.c.query(
    `SELECT id, event_id, status, attempts, next_attempt_at, last_attempt_at, lease_until,
            last_error_code, last_response_status, last_duration_ms, succeeded_at
       FROM webhook_delivery WHERE endpoint_id = $1 ORDER BY created_at, id`,
    [endpointId],
  );
  return rows;
}

const sendingCount = async (endpointId: string) =>
  (
    await h.c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM webhook_delivery WHERE endpoint_id = $1 AND status = 'sending'`,
      [endpointId],
    )
  ).rows[0]!.n;

const verifier = (s: Secret) => new Webhook(s.reveal().slice('whsec_'.length));

describe('WebhookDispatcher delivery', () => {
  it('sends one signed request per event and records success', async () => {
    const { d, transport } = start();
    const { t, endpointId, secret } = await setup();
    const [c] = await comments(t);
    const eventId = await eventOf(c!);
    await run(d);
    expect(transport.sent).toHaveLength(1);
    const req = transport.sent[0]!;
    expect(req.url.href).toBe('https://hooks.example.com/private/path?token=abc');
    expect(JSON.parse(req.body).id).toBe(eventId);
    expect(req.headers['webhook-id']).toBe(eventId);
    expect(req.headers['webhook-timestamp']).toBe(String(Math.floor(clock.getTime() / 1000)));
    expect(verifier(secret).verify(req.body, req.headers)).toMatchObject({ id: eventId });
    const [row] = await rowsOf(endpointId);
    expect(row).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      last_response_status: 204,
      last_duration_ms: 7,
      lease_until: null,
      last_error_code: null,
    });
    expect(row.succeeded_at).toEqual(clock);
    expect(req.headers['feedbouncer-delivery-id']).toBe(row.id);
  });

  it('sends exactly one request per subscribed endpoint over several ticks', async () => {
    const { d, transport } = start();
    const a = await setup('a.example.com');
    await setup('b.example.com', a.t);
    await comments(a.t);
    await run(d, 5);
    expect(transport.to('a.example.com')).toHaveLength(1);
    expect(transport.to('b.example.com')).toHaveLength(1);
  });

  it('retries on the jittered schedule and fails after the seventh attempt', async () => {
    const { d, transport } = start({ random: () => 1 });
    transport.reply = () => FAIL;
    const { t, endpointId } = await setup();
    await comments(t);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await run(d);
      expect(transport.sent).toHaveLength(i + 1);
      if (i === MAX_ATTEMPTS - 1) break;
      const delay = Math.round(RETRY_DELAYS_SECONDS[i]! * 1.1);
      const [row] = await rowsOf(endpointId);
      expect(row).toMatchObject({
        status: 'retrying',
        attempts: i + 1,
        last_error_code: 'http_status',
      });
      expect((row.next_attempt_at.getTime() - row.last_attempt_at.getTime()) / 1000).toBe(delay);
      advance(delay - 1);
      await run(d);
      expect(transport.sent).toHaveLength(i + 1);
      advance(1);
    }
    expect((await rowsOf(endpointId))[0]).toMatchObject({
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      last_error_code: 'http_status',
      last_response_status: 500,
    });
    advance(2 * DAY);
    await run(d);
    expect(transport.sent).toHaveLength(MAX_ATTEMPTS);
  });

  it('stamps each attempt with the time it is sent, not the event time', async () => {
    const { d, transport } = start();
    const { t, endpointId } = await setup();
    const [c] = await comments(t);
    const { rows } = await h.c.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM webhook_event WHERE comment_id = $1',
      [c],
    );
    await h.c.query(
      `UPDATE webhook_delivery SET status = 'retrying', attempts = 6 WHERE endpoint_id = $1`,
      [endpointId],
    );
    clock = new Date(rows[0]!.occurred_at.getTime() + (20 * 3600 + 36 * 60) * 1000);
    await run(d);
    const ts = Number(transport.sent[0]!.headers['webhook-timestamp']);
    expect(ts).toBe(Math.floor(clock.getTime() / 1000));
    expect(ts - Math.floor(rows[0]!.occurred_at.getTime() / 1000)).toBe(20 * 3600 + 36 * 60);
  });

  it('signs with both secrets during a rotation overlap, and only the new one after it', async () => {
    const { d, transport } = start();
    const { t, ctx, endpointId, secret: old } = await setup();
    const rotated = (await endpoints.rotateSecret(ctx, endpointId))!;
    await comments(t);
    await run(d);
    const during = transport.sent[0]!;
    expect(during.headers['webhook-signature']!.split(' ')).toHaveLength(2);
    for (const s of [old, rotated.secret]) {
      expect(verifier(s).verify(during.body, during.headers)).toBeTruthy();
    }

    clock = new Date(new Date(rotated.previousSecretExpiresAt).getTime() + 1000);
    await comments(t);
    await run(d);
    const after = transport.sent[1]!;
    const sig = after.headers['webhook-signature']!;
    const expected = createHmac(
      'sha256',
      Buffer.from(rotated.secret.reveal().slice('whsec_'.length), 'base64'),
    )
      .update(`${after.headers['webhook-id']}.${after.headers['webhook-timestamp']}.${after.body}`)
      .digest('base64');
    expect(sig).toBe(`v1,${expected}`);
  });
});

describe('WebhookDispatcher fairness', () => {
  it("does not let one organization's burst delay another's event", async () => {
    const { d, transport } = start();
    transport.reply = (url) => (url.hostname === 'burst.example.com' ? null : OK);
    const a = await setup('burst.example.com');
    const b = await setup('quiet.example.com');
    await comments(a.t, 5000);
    await comments(b.t);
    await d.tick();
    await vi.waitFor(() => expect(transport.to('quiet.example.com')).toHaveLength(1));
    expect(transport.to('burst.example.com').length).toBeLessThanOrEqual(PER_ENDPOINT_IN_FLIGHT);
    expect(await sendingCount(a.endpointId)).toBeLessThanOrEqual(PER_ENDPOINT_IN_FLIGHT);
  });

  it('keeps delivering to a fast endpoint while a slow one holds its slots', async () => {
    const { d, transport } = start();
    transport.reply = (url) => (url.hostname === 'slow.example.com' ? null : OK);
    const a = await setup('slow.example.com');
    const b = await setup('fast.example.com');
    await comments(a.t, 10);
    for (let i = 1; i <= 3; i++) {
      await comments(b.t);
      await d.tick();
      await vi.waitFor(() => expect(transport.to('fast.example.com')).toHaveLength(i));
      expect(transport.to('slow.example.com')).toHaveLength(PER_ENDPOINT_IN_FLIGHT);
      expect(await sendingCount(a.endpointId)).toBe(PER_ENDPOINT_IN_FLIGHT);
    }
  });

  it('holds the in-flight caps when several dispatchers claim at once', async () => {
    const { d, transport } = start();
    transport.reply = () => null;
    const others = Array.from({ length: 3 }, () => dispatcher(transport));
    const a = await setup('slow.example.com');
    const second = await setup('slow2.example.com', a.t);
    await comments(a.t, 40);
    for (let round = 0; round < 3; round++) {
      await Promise.all([d, ...others].map((x) => x.tick()));
    }
    expect(await sendingCount(a.endpointId)).toBeLessThanOrEqual(PER_ENDPOINT_IN_FLIGHT);
    expect(await sendingCount(second.endpointId)).toBeLessThanOrEqual(PER_ENDPOINT_IN_FLIGHT);
    expect(
      (await sendingCount(a.endpointId)) + (await sendingCount(second.endpointId)),
    ).toBeLessThanOrEqual(PER_ORG_IN_FLIGHT);
  });
});

describe('WebhookDispatcher.reap', () => {
  it('retries a delivery whose lease expired, with the same webhook-id', async () => {
    const { d, transport } = start();
    transport.reply = () => null;
    const { t, endpointId } = await setup();
    await comments(t);
    await d.tick();
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    expect(await d.reap()).toBe(0);

    advance(61);
    const other = dispatcher(transport);
    expect(await other.reap()).toBe(1);
    expect((await rowsOf(endpointId))[0]).toMatchObject({ status: 'retrying', attempts: 1 });
    transport.reply = () => OK;
    await run(other);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.headers['webhook-id']).toBe(transport.sent[0]!.headers['webhook-id']);

    transport.sent[0]!.settle(FAIL);
    await d.drain();
    expect((await rowsOf(endpointId))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('fails an expired lease on the last attempt as outcome_unknown', async () => {
    const { d } = start();
    const { t, endpointId } = await setup();
    await comments(t);
    await h.c.query(
      `UPDATE webhook_delivery SET status = 'sending', attempts = $2, lease_until = $3 WHERE endpoint_id = $1`,
      [endpointId, MAX_ATTEMPTS, new Date(clock.getTime() - 1000)],
    );
    expect(await d.reap()).toBe(1);
    expect((await rowsOf(endpointId))[0]).toMatchObject({
      status: 'failed',
      last_error_code: 'outcome_unknown',
      lease_until: null,
    });
  });
});

describe('WebhookDispatcher auto-disable', () => {
  async function member(t: Tenant, role: string, verified: boolean): Promise<string> {
    const email = `${role}-${uuid()}@example.test`;
    const { rows } = await h.c.query<{ id: string }>(
      'INSERT INTO app_user (email, email_verified) VALUES ($1, $2) RETURNING id',
      [email, verified],
    );
    await h.c.query('INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)', [
      t.organizationId,
      rows[0]!.id,
      role,
    ]);
    return email;
  }

  it('disables after 20 failures spanning 24 hours, cancels the rest and emails owners and admins', async () => {
    const { d, transport } = start();
    transport.reply = () => FAIL;
    const { t, ctx, endpointId, secret } = await setup();
    const { rows: owner } = await h.c.query<{ email: string }>(
      'UPDATE app_user SET email_verified = true WHERE id = $1 RETURNING email',
      [t.userId],
    );
    const admin = await member(t, 'admin', true);
    await member(t, 'admin', false);
    await member(t, 'member', true);

    await comments(t, 19);
    await run(d, 5);
    expect(transport.sent).toHaveLength(19);
    const first = new Date(clock);
    advance(DAY + 1);
    await comments(t);
    await run(d);

    const { rows: ep } = await h.c.query(
      'SELECT status, disabled_reason, disabled_at FROM webhook_endpoint WHERE id = $1',
      [endpointId],
    );
    expect(ep[0]).toMatchObject({ status: 'disabled', disabled_reason: 'consecutive_failures' });
    expect(ep[0].disabled_at).toEqual(clock);
    const rows = await rowsOf(endpointId);
    const open = rows.filter((r) => ['pending', 'retrying', 'sending'].includes(r.status));
    expect(open).toEqual([]);
    expect(rows.filter((r) => r.status === 'cancelled').length).toBeGreaterThan(0);
    for (const r of rows.filter((r) => r.status === 'cancelled')) {
      expect(r.last_error_code).toBe('endpoint_disabled');
    }

    const { rows: audit } = await h.c.query(
      `SELECT actor_type, subject_id, details FROM audit_event
        WHERE organization_id = $1 AND action = 'webhook_endpoint.disabled'`,
      [t.organizationId],
    );
    expect(audit).toEqual([
      {
        actor_type: 'system',
        subject_id: endpointId,
        details: { failures: 20, since: first.toISOString() },
      },
    ]);

    expect(mailer.sent.map((m) => m.to).sort()).toEqual([owner[0]!.email, admin].sort());
    for (const m of mailer.sent) {
      expect(m.subject).toBe('FeedBouncer webhook endpoint disabled');
      expect(m.text).toContain('hooks.example.com');
      expect(m.text).not.toContain('/private/path');
      expect(m.text).not.toContain('token=abc');
    }

    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('whsec_');
    expect(logged).not.toContain(secret.reveal());
    expect(logged).not.toContain('/private/path');
    expect(logged).not.toContain('token=abc');
    expect(lines.find((l) => l.msg === 'webhooks.delivery_attempt')).toMatchObject({
      endpointId,
      host: 'hooks.example.com',
      eventType: 'comment.received',
      attempt: 1,
      outcome: 'retrying',
      code: 'http_status',
      status: 500,
    });

    // Disabled: new events are not recorded for the endpoint.
    const before = rows.length;
    await comments(t);
    expect(await rowsOf(endpointId)).toHaveLength(before);

    // Re-enabled: a delivery cancelled by the disable can be redelivered.
    await endpoints.update(ctx, endpointId, { status: 'active' });
    const cancelled = rows.find((r) => r.status === 'cancelled')!;
    const redelivery = (await deliveries.redeliver(ctx, endpointId, cancelled.id))!;
    transport.reply = () => OK;
    await run(d);
    const last = transport.sent.at(-1)!;
    expect(last.headers['webhook-id']).toBe(cancelled.event_id);
    expect((await rowsOf(endpointId)).find((r) => r.id === redelivery.id)).toMatchObject({
      status: 'succeeded',
    });
  });

  it('stays active after 20 failures within an hour', async () => {
    const { d, transport } = start();
    transport.reply = () => FAIL;
    const { t, endpointId } = await setup();
    await h.c.query('UPDATE app_user SET email_verified = true WHERE id = $1', [t.userId]);
    await comments(t, 20);
    await run(d, 5);
    advance(59 * 60);
    await run(d, 5);
    const { rows } = await h.c.query(
      'SELECT status, consecutive_failures FROM webhook_endpoint WHERE id = $1',
      [endpointId],
    );
    expect(rows[0].status).toBe('active');
    expect(rows[0].consecutive_failures).toBeGreaterThanOrEqual(20);
    expect(mailer.sent).toEqual([]);
  });

  it('a mail failure is logged and never thrown', async () => {
    const { transport } = start();
    transport.reply = () => FAIL;
    const failing = { send: () => Promise.reject(new Error('smtp down')) };
    const d = new WebhookDispatcher({
      pool,
      endpoints,
      transport,
      mailer: failing,
      log,
      metrics: createWebhookMetrics(new Registry()),
      concurrency: 32,
      now: () => clock,
      random: () => 0.5,
    });
    dispatchers.push(d);
    const { t, endpointId } = await setup();
    await h.c.query('UPDATE app_user SET email_verified = true WHERE id = $1', [t.userId]);
    await h.c.query(
      `UPDATE webhook_endpoint SET consecutive_failures = 19, first_failure_at = $2 WHERE id = $1`,
      [endpointId, new Date(clock.getTime() - (DAY + 1) * 1000)],
    );
    await comments(t);
    await run(d);
    const { rows } = await h.c.query('SELECT status FROM webhook_endpoint WHERE id = $1', [
      endpointId,
    ]);
    expect(rows[0].status).toBe('disabled');
    expect(lines.filter((l) => l.msg === 'webhooks.disable_notify_failed')).toHaveLength(1);
  });
});

describe('WebhookDispatcher privacy and retention', () => {
  it('cancels a delivery whose comment was deleted, and refuses to redeliver it', async () => {
    const { d, transport } = start();
    const { t, ctx, endpointId } = await setup();
    const [c] = await comments(t);
    await h.c.query(`UPDATE comment SET platform_state = 'deleted' WHERE id = $1`, [c]);
    await run(d);
    expect(transport.sent).toEqual([]);
    const [row] = await rowsOf(endpointId);
    expect(row).toMatchObject({ status: 'cancelled', last_error_code: 'subject_gone' });
    await expect(deliveries.redeliver(ctx, endpointId, row.id)).rejects.toBeInstanceOf(
      EventUnavailableError,
    );
  });

  it('purges events older than the retention period with their deliveries, and expired rotation secrets', async () => {
    const { d } = start();
    const { t, ctx, endpointId } = await setup();
    const [old, fresh] = await comments(t, 2);
    const oldEvent = await eventOf(old!);
    await h.c.query(`UPDATE webhook_event SET created_at = $2 WHERE id = $1`, [
      oldEvent,
      new Date(clock.getTime() - 31 * DAY * 1000),
    ]);
    const rotated = (await endpoints.rotateSecret(ctx, endpointId))!;
    clock = new Date(new Date(rotated.previousSecretExpiresAt).getTime() + 1000);
    expect(await d.purge()).toBeGreaterThanOrEqual(2);
    const { rows: events } = await h.c.query(
      'SELECT comment_id FROM webhook_event WHERE organization_id = $1',
      [t.organizationId],
    );
    expect(events.map((e) => e.comment_id)).toEqual([fresh]);
    expect((await rowsOf(endpointId)).map((r) => r.event_id)).toEqual([await eventOf(fresh!)]);
    const { rows: ep } = await h.c.query(
      `SELECT previous_signing_key_id, encrypted_previous_signing_secret, rotation_overlap_until
         FROM webhook_endpoint WHERE id = $1`,
      [endpointId],
    );
    expect(ep[0]).toEqual({
      previous_signing_key_id: null,
      encrypted_previous_signing_secret: null,
      rotation_overlap_until: null,
    });
  });
});
