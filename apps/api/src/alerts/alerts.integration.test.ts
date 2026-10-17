import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgAlertChannels,
  createAlertEvent,
  unsubscribeApiUrl,
  type AlertPayload,
} from '@feedbouncer/alerts';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

const SLACK_URL = 'https://hooks.slack.com/services/T0AAAA1111/B0BBBB2222/abcdefghijklmnopqrstuvwx';
const SLACK_URL_2 =
  'https://hooks.slack.com/services/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';
const SECRET_PART = 'abcdefghijklmnopqrstuvwx';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

let slackReply: () => Response = () => new Response('ok', { status: 200 });
const slackCalls: string[] = [];
const fakeSlack = (async (input: Parameters<typeof fetch>[0]) => {
  slackCalls.push(String(input));
  return slackReply();
}) as typeof fetch;

let api: TestApi;
let org: OrgFixture;
let other: OrgFixture;
let channels: PgAlertChannels;

beforeAll(async () => {
  api = await startTestApi(
    { alerts: { slack: true, email: true, capPerHour: 30, emailPerMinute: 60 } },
    { alertsFetch: fakeSlack },
  );
  const owner = await verifiedUser(api, 'al-owner');
  const admin = await verifiedUser(api, 'al-admin');
  const member = await verifiedUser(api, 'al-member');
  org = await orgWithRoles(api, 'alA', { owner, admin, member });
  other = await orgWithRoles(api, 'alB', { owner, admin, member });
  channels = new PgAlertChannels(api.pool, api.deps.env.encryption);
});
afterAll(() => api.close());

const base = () => `/api/v1/orgs/${org.orgId}/alert-channels`;
const brandUrl = (o: OrgFixture = org) => `/api/v1/orgs/${o.orgId}/brands/${o.brandId}/alerts`;
const SETTINGS = {
  sensitivity: 'high',
  minNegativeCount: 5,
  cooldownMinutes: 60,
  contentMode: 'counts_only',
};

async function connectSlack(label = 'ops', url = SLACK_URL, o: OrgFixture = org) {
  const r = await api.req('POST', `/api/v1/orgs/${o.orgId}/alert-channels/slack`, {
    cookie: o.admin.cookie,
    body: { label, webhookUrl: url },
  });
  expect(r.status).toBe(201);
  return r.body.channel as { id: string };
}

async function addEmail(address: string) {
  const r = await api.req('POST', `${base()}/email`, {
    cookie: org.admin.cookie,
    body: { email: address },
  });
  expect(r.status).toBe(201);
  return r.body.channel as { id: string };
}

describe('alerts API', () => {
  it('admin connects Slack and test send succeeds; GET never returns the URL', async () => {
    const ch = await connectSlack();
    const t = await api.req('POST', `${base()}/${ch.id}/test`, { cookie: org.admin.cookie });
    expect(t.status).toBe(200);
    expect(t.body).toEqual({ ok: true });
    expect(slackCalls.at(-1)).toBe(SLACK_URL);
    const list = await api.raw('GET', base(), { headers: { cookie: org.admin.cookie } });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('hooks.slack.com');
    expect(list.text).not.toContain(SECRET_PART);
    expect(JSON.parse(list.text)).toMatchObject({
      availability: { slack: true, email: true },
      channels: [{ id: ch.id, kind: 'slack', status: 'active', hint: 'T…1111/B…2222' }],
    });
    const brand = await api.raw('GET', brandUrl(), { headers: { cookie: org.admin.cookie } });
    expect(brand.text).not.toContain(SECRET_PART);
    expect(api.logLines.join('\n')).not.toContain(SECRET_PART);
    await api.req('DELETE', `${base()}/${ch.id}`, { cookie: org.admin.cookie });
  });

  it('invalid webhook URL → 400 and nothing stored', async () => {
    const calls = slackCalls.length;
    for (const webhookUrl of [
      'http://169.254.169.254/services/T00/B00/abcdefghijklmnop',
      'https://hooks.slack.com.evil.io/services/T0AAAA1111/B0BBBB2222/abcdefghijklmnopqrstuvwx',
      `${SLACK_URL}?x=1`,
      'not a url',
    ]) {
      const r = await api.req('POST', `${base()}/slack`, {
        cookie: org.admin.cookie,
        body: { label: 'bad', webhookUrl },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_webhook_url');
    }
    const n = await api.pool.query(
      'SELECT count(*)::int AS n FROM alert_channel WHERE label = $1',
      ['bad'],
    );
    expect(n.rows[0].n).toBe(0);
    expect(slackCalls).toHaveLength(calls);
  });

  it('test send to revoked webhook → ok false no_service and channel disconnected', async () => {
    const ch = await connectSlack('revoked');
    slackReply = () => new Response('no_service', { status: 404 });
    try {
      const t = await api.req('POST', `${base()}/${ch.id}/test`, { cookie: org.admin.cookie });
      expect(t.status).toBe(200);
      expect(t.body).toEqual({ ok: false, code: 'no_service' });
    } finally {
      slackReply = () => new Response('ok', { status: 200 });
    }
    const list = await api.req('GET', base(), { cookie: org.admin.cookie });
    const row = list.body.channels.find((c: { id: string }) => c.id === ch.id);
    expect(row).toMatchObject({ status: 'disconnected', disconnectedCode: 'no_service' });
  });

  it('reconnect with a new URL → active, failures cleared', async () => {
    const ch = await connectSlack('reconnect');
    slackReply = () => new Response('no_service', { status: 404 });
    await api.req('POST', `${base()}/${ch.id}/test`, { cookie: org.admin.cookie });
    slackReply = () => new Response('ok', { status: 200 });
    const bad = await api.req('PUT', `${base()}/${ch.id}/slack`, {
      cookie: org.admin.cookie,
      body: { webhookUrl: 'https://example.com/x' },
    });
    expect(bad.status).toBe(400);
    const r = await api.req('PUT', `${base()}/${ch.id}/slack`, {
      cookie: org.admin.cookie,
      body: { webhookUrl: SLACK_URL_2 },
    });
    expect(r.status).toBe(200);
    expect(r.body.channel).toMatchObject({
      status: 'active',
      health: 'active',
      lastFailureCode: null,
      disconnectedCode: null,
      hint: 'T…3333/B…4444',
    });
    const t = await api.req('POST', `${base()}/${ch.id}/test`, { cookie: org.admin.cookie });
    expect(t.body).toEqual({ ok: true });
    expect(slackCalls.at(-1)).toBe(SLACK_URL_2);
    const missing = await api.req('PUT', `${base()}/${randomUUID()}/slack`, {
      cookie: org.admin.cookie,
      body: { webhookUrl: SLACK_URL },
    });
    expect(missing.status).toBe(404);
  });

  it('add email → confirmation mail; unconfirmed route gets no delivery; confirm → active', async () => {
    const address = `Pending-${randomUUID().slice(0, 6)}@Alerts.Test`;
    const ch = await addEmail(address);
    const mail = api.mailer.lastTo(address.toLowerCase())!;
    expect(mail.subject).toContain('Confirm FeedBouncer alerts');
    const url = new URL(extractFirstUrl(mail.text)!);
    expect(url.pathname).toBe('/alerts/confirm');
    const token = url.searchParams.get('token')!;

    const put = await api.req('PUT', brandUrl(), {
      cookie: org.admin.cookie,
      body: {
        settings: SETTINGS,
        routes: [{ alertType: 'negative_spike', channelId: ch.id, enabled: true }],
      },
    });
    expect(put.status).toBe(200);

    const fire = async (key: string) => {
      const c = await api.pool.connect();
      try {
        return await createAlertEvent(
          c,
          {
            organizationId: org.orgId,
            brandId: org.brandId,
            type: 'negative_spike',
            key,
            windowStart: new Date(Date.now() - 3_600_000),
            windowEnd: new Date(),
            payload: spikePayload(),
          },
          { capPerHour: 30, routeType: 'negative_spike', now: new Date() },
        );
      } finally {
        c.release();
      }
    };
    expect(await fire(`spike:${randomUUID()}`)).toMatchObject({ status: 'created', deliveries: 0 });

    const bad = await api.req('POST', '/api/v1/alert-recipients/confirm', {
      body: { token: 'a'.repeat(43) },
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('invalid_token');
    const ok = await api.req('POST', '/api/v1/alert-recipients/confirm', {
      body: { token },
      headers: { origin: '' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'confirmed' });
    const again = await api.req('POST', '/api/v1/alert-recipients/confirm', { body: { token } });
    expect(again.status).toBe(404);
    expect(await fire(`spike:${randomUUID()}`)).toMatchObject({ status: 'created', deliveries: 1 });
  });

  it('resend confirmation: 202 with a fresh mail, then too_soon; a mail failure leaves it pending', async () => {
    const address = `resend-${randomUUID().slice(0, 6)}@alerts.test`;
    const ch = await addEmail(address);
    const soon = await api.req('POST', `${base()}/${ch.id}/resend-confirmation`, {
      cookie: org.admin.cookie,
    });
    expect(soon.status).toBe(409);
    expect(soon.body.error.code).toBe('too_soon');
    // Refused clicks must not spend the address's hourly email allowance.
    for (let i = 0; i < 3; i++) {
      const again = await api.req('POST', `${base()}/${ch.id}/resend-confirmation`, {
        cookie: org.admin.cookie,
      });
      expect(again.status).toBe(409);
    }
    // The updated_at trigger would overwrite the backdated value.
    await api.pool.query('ALTER TABLE alert_channel DISABLE TRIGGER USER');
    await api.pool.query(
      "UPDATE alert_channel SET updated_at = now() - interval '2 minutes' WHERE id = $1",
      [ch.id],
    );
    await api.pool.query('ALTER TABLE alert_channel ENABLE TRIGGER USER');
    const before = api.mailer.sent.length;
    const r = await api.req('POST', `${base()}/${ch.id}/resend-confirmation`, {
      cookie: org.admin.cookie,
    });
    expect(r.status).toBe(202);
    expect(api.mailer.sent.length).toBe(before + 1);
    const slack = await connectSlack('not-email');
    const wrongKind = await api.req('POST', `${base()}/${slack.id}/resend-confirmation`, {
      cookie: org.admin.cookie,
    });
    expect(wrongKind.status).toBe(404);

    const send = api.deps.mailer.send.bind(api.deps.mailer);
    (api.deps.mailer as { send: unknown }).send = async () => {
      throw new Error('smtp send failed', { cause: { responseCode: 550 } });
    };
    try {
      const failed = await api.req('POST', `${base()}/email`, {
        cookie: org.admin.cookie,
        body: { email: `fail-${randomUUID().slice(0, 6)}@alerts.test` },
      });
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe('confirmation_send_failed');
    } finally {
      (api.deps.mailer as { send: unknown }).send = send;
    }
    const list = await api.req('GET', base(), { cookie: org.admin.cookie });
    expect(
      list.body.channels.filter((c: { status: string }) => c.status === 'pending_confirmation')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('email validation and duplicates', async () => {
    const address = `dup-${randomUUID().slice(0, 6)}@alerts.test`;
    await addEmail(address);
    for (const [email, code, status] of [
      [address.toUpperCase(), 'email_taken', 409],
      ['a@b,c@d', 'invalid_email', 400],
      ['<a@b.test>', 'invalid_email', 400],
    ] as const) {
      const r = await api.req('POST', `${base()}/email`, {
        cookie: org.admin.cookie,
        body: { email },
      });
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(code);
    }
  });

  it('unsubscribe via one-click form POST → unsubscribed; GET shows status', async () => {
    const address = `unsub-${randomUUID().slice(0, 6)}@alerts.test`;
    const ch = await addEmail(address);
    const token = (await channels.openUnsubscribeToken(org.orgId, ch.id))!;
    const link = new URL(unsubscribeApiUrl(api.deps.env.publicWebUrl, token));
    // A foreign Origin and a form body: exactly what a mail client's one-click POST looks like.
    const r = await api.raw('POST', `${link.pathname}${link.search}`, {
      body: 'List-Unsubscribe=One-Click',
      headers: { ...FORM, origin: 'https://mail.example' },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ status: 'unsubscribed' });
    const list = await api.req('GET', base(), { cookie: org.admin.cookie });
    expect(list.body.channels.find((c: { id: string }) => c.id === ch.id).status).toBe(
      'unsubscribed',
    );
    const again = await api.raw('POST', `${link.pathname}${link.search}`, {
      body: 'List-Unsubscribe=One-Click',
      headers: FORM,
    });
    expect(JSON.parse(again.text)).toEqual({ status: 'already' });
    const badBody = await api.raw('POST', `${link.pathname}${link.search}`, {
      body: 'List-Unsubscribe=nope',
      headers: FORM,
    });
    expect(badBody.status).toBe(400);
    const badToken = await api.raw('POST', `${link.pathname}?token=${'z'.repeat(43)}`, {
      body: 'List-Unsubscribe=One-Click',
      headers: FORM,
    });
    expect(badToken.status).toBe(404);
    // JSON body works too, and the form parser exists for this route only.
    const json = await api.req('POST', '/api/v1/alert-recipients/unsubscribe', { body: { token } });
    expect(json.body).toEqual({ status: 'already' });
    const elsewhere = await api.raw('POST', '/api/v1/alert-recipients/confirm', {
      body: `token=${token}`,
      headers: FORM,
    });
    expect(elsewhere.status).toBe(415);
  });

  it('member: GET alert-channels 403, PUT brand alerts 403', async () => {
    const g = await api.req('GET', base(), { cookie: org.member.cookie });
    expect(g.status).toBe(403);
    const p = await api.req('PUT', brandUrl(), {
      cookie: org.member.cookie,
      body: { settings: SETTINGS, routes: [] },
    });
    expect(p.status).toBe(403);
    const t = await api.req('POST', `${base()}/slack`, {
      cookie: org.member.cookie,
      body: { label: 'x', webhookUrl: SLACK_URL },
    });
    expect(t.status).toBe(403);
  });

  it('PUT brand alerts with org B channel → 422 unknown_channel, nothing written', async () => {
    const foreign = await connectSlack('foreign', SLACK_URL, other);
    const r = await api.req('PUT', brandUrl(), {
      cookie: org.admin.cookie,
      body: {
        settings: SETTINGS,
        routes: [{ alertType: 'negative_spike', channelId: foreign.id, enabled: true }],
      },
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('unknown_channel');
    const n = await api.pool.query(
      'SELECT count(*)::int AS n FROM alert_route WHERE channel_id = $1',
      [foreign.id],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('per alert type channel toggles persist independently', async () => {
    const slack = await connectSlack('toggle-slack');
    const mail = await addEmail(`toggle-${randomUUID().slice(0, 6)}@alerts.test`);
    const put = (routes: unknown[]) =>
      api.req('PUT', brandUrl(), {
        cookie: org.admin.cookie,
        body: { settings: SETTINGS, routes },
      });
    const first = await put([
      { alertType: 'negative_spike', channelId: slack.id, enabled: true },
      { alertType: 'flagged_item', channelId: mail.id, enabled: true },
      { alertType: 'negative_spike', channelId: mail.id, enabled: false },
      { alertType: 'flagged_item', channelId: slack.id, enabled: false },
    ]);
    expect(first.status).toBe(200);
    const get = await api.req('GET', brandUrl(), { cookie: org.admin.cookie });
    expect(get.body.settings).toEqual(SETTINGS);
    const enabled = (body: {
      routes: { alertType: string; channelId: string; enabled: boolean }[];
    }) =>
      body.routes
        .filter((r) => r.enabled)
        .map((r) => `${r.alertType}:${r.channelId}`)
        .sort();
    expect(enabled(get.body)).toEqual(
      [`negative_spike:${slack.id}`, `flagged_item:${mail.id}`].sort(),
    );
    // Flipping only the flag route leaves the spike route alone.
    const second = await put([
      { alertType: 'negative_spike', channelId: slack.id, enabled: true },
      { alertType: 'flagged_item', channelId: mail.id, enabled: false },
      { alertType: 'flagged_item', channelId: slack.id, enabled: true },
    ]);
    expect(enabled(second.body)).toEqual(
      [`negative_spike:${slack.id}`, `flagged_item:${slack.id}`].sort(),
    );
    expect(second.body.channels.map((c: { id: string }) => c.id)).toContain(mail.id);
    const dup = await put([
      { alertType: 'negative_spike', channelId: slack.id, enabled: true },
      { alertType: 'negative_spike', channelId: slack.id, enabled: false },
    ]);
    expect(dup.status).toBe(400);
  });

  it('recent alerts list shows explanation and per-channel delivery state', async () => {
    const slack = await connectSlack('recent');
    await api.req('PUT', brandUrl(), {
      cookie: org.admin.cookie,
      body: {
        settings: SETTINGS,
        routes: [{ alertType: 'negative_spike', channelId: slack.id, enabled: true }],
      },
    });
    const c = await api.pool.connect();
    try {
      await createAlertEvent(
        c,
        {
          organizationId: org.orgId,
          brandId: org.brandId,
          type: 'negative_spike',
          key: `spike:${randomUUID()}`,
          windowStart: new Date(Date.now() - 3_600_000),
          windowEnd: new Date(),
          payload: spikePayload(),
        },
        { capPerHour: 30, routeType: 'negative_spike', now: new Date() },
      );
    } finally {
      c.release();
    }
    const r = await api.req('GET', brandUrl(), { cookie: org.admin.cookie });
    const ev = r.body.recent[0];
    expect(ev).toMatchObject({
      type: 'negative_spike',
      status: 'queued',
      counts: { negatives: 12, total: 40 },
      explanation: { trigger: 'volume', expectedPerHour: 2, sensitivity: 'high', minCount: 5 },
    });
    expect(ev.deliveries).toEqual([{ channelId: slack.id, state: 'pending', lastErrorCode: null }]);
    expect(JSON.stringify(r.body.recent)).not.toContain('commentIds');
    expect(r.body.recent.length).toBeLessThanOrEqual(20);
  });

  it('archived brand → 404', async () => {
    const created = await api.req('POST', `/api/v1/orgs/${org.orgId}/brands`, {
      cookie: org.owner.cookie,
      body: { name: 'Soon archived' },
    });
    expect(created.status).toBe(201);
    const brandId = created.body.brand.id as string;
    const url = `/api/v1/orgs/${org.orgId}/brands/${brandId}/alerts`;
    expect((await api.req('GET', url, { cookie: org.admin.cookie })).status).toBe(200);
    const arch = await api.req('POST', `/api/v1/orgs/${org.orgId}/brands/${brandId}/archive`, {
      cookie: org.owner.cookie,
      body: {},
    });
    expect(arch.status).toBe(200);
    expect((await api.req('GET', url, { cookie: org.admin.cookie })).status).toBe(404);
    const put = await api.req('PUT', url, {
      cookie: org.admin.cookie,
      body: { settings: SETTINGS, routes: [] },
    });
    expect(put.status).toBe(404);
  });

  it('confirmation mails share the email budget: add/delete/add loops stop at 3 per address', async () => {
    const address = `loop-${randomUUID().slice(0, 6)}@alerts.test`;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await api.req('POST', `${base()}/email`, {
        cookie: org.admin.cookie,
        body: { email: address },
      });
      codes.push(r.status);
      if (r.status === 201) {
        await api.req('DELETE', `${base()}/${r.body.channel.id}`, { cookie: org.admin.cookie });
      }
    }
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  it('an unsubscribed address cannot be sent another confirmation', async () => {
    const ch = await addEmail(`unsub-${randomUUID().slice(0, 6)}@alerts.test`);
    const token = (await channels.openUnsubscribeToken(org.orgId, ch.id))!;
    await channels.unsubscribe(token);
    const before = api.mailer.sent.length;
    const r = await api.req('POST', `${base()}/${ch.id}/resend-confirmation`, {
      cookie: org.admin.cookie,
    });
    expect(r.status).toBe(404);
    expect(api.mailer.sent.length).toBe(before);
  });

  it('test send is limited to 5 per channel per minute', async () => {
    const ch = await connectSlack('limited');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (await api.req('POST', `${base()}/${ch.id}/test`, { cookie: org.admin.cookie })).status,
      );
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('audit rows for create, reconnect, delete and settings, with no URL or email in details', async () => {
    const o = await orgWithRoles(api, 'alAudit', org);
    const ch = await connectSlack('audited', SLACK_URL, o);
    await api.req('PUT', `/api/v1/orgs/${o.orgId}/alert-channels/${ch.id}/slack`, {
      cookie: o.admin.cookie,
      body: { webhookUrl: SLACK_URL_2 },
    });
    const mail = await api.req('POST', `/api/v1/orgs/${o.orgId}/alert-channels/email`, {
      cookie: o.admin.cookie,
      body: { email: 'audit-person@alerts.test' },
    });
    await api.req('PUT', brandUrl(o), {
      cookie: o.admin.cookie,
      body: {
        settings: SETTINGS,
        routes: [{ alertType: 'negative_spike', channelId: ch.id, enabled: true }],
      },
    });
    const del = await api.req('DELETE', `/api/v1/orgs/${o.orgId}/alert-channels/${ch.id}`, {
      cookie: o.admin.cookie,
    });
    expect(del.status).toBe(204);
    const rows = await api.pool.query(
      `SELECT action, subject_type, details, actor_user_id FROM audit_event
        WHERE organization_id = $1 AND action LIKE 'alert.%' ORDER BY sequence`,
      [o.orgId],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'alert.channel_created',
        'alert.channel_reconnected',
        'alert.settings_updated',
        'alert.channel_deleted',
      ]),
    );
    expect(rows.rows.every((r) => r.actor_user_id === o.admin.userId)).toBe(true);
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain('hooks.slack.com');
    expect(dump).not.toContain(SECRET_PART);
    expect(dump).not.toContain('audit-person');
    expect(dump).not.toContain('@');
    expect(mail.status).toBe(201);
  });
});

describe('alerts unavailable (ALERT_CHANNELS empty)', () => {
  it('GET availability false; POST slack 409 alerts_unavailable; no error log lines', async () => {
    const off = await startTestApi({
      alerts: { slack: false, email: false, capPerHour: 30, emailPerMinute: 60 },
    });
    try {
      const o = await orgWithRoles(off, 'alOff');
      const g = await off.req('GET', `/api/v1/orgs/${o.orgId}/alert-channels`, {
        cookie: o.admin.cookie,
      });
      expect(g.status).toBe(200);
      expect(g.body).toEqual({ availability: { slack: false, email: false }, channels: [] });
      const s = await off.req('POST', `/api/v1/orgs/${o.orgId}/alert-channels/slack`, {
        cookie: o.admin.cookie,
        body: { label: 'x', webhookUrl: SLACK_URL },
      });
      expect(s.status).toBe(409);
      expect(s.body.error.code).toBe('alerts_unavailable');
      const e = await off.req('POST', `/api/v1/orgs/${o.orgId}/alert-channels/email`, {
        cookie: o.admin.cookie,
        body: { email: 'a@alerts.test' },
      });
      expect(e.status).toBe(409);
      const b = await off.req('GET', `/api/v1/orgs/${o.orgId}/brands/${o.brandId}/alerts`, {
        cookie: o.admin.cookie,
      });
      expect(b.status).toBe(200);
      expect(b.body.availability).toEqual({ slack: false, email: false });
      expect(off.logLines.filter((l) => l.includes('"level":"error"'))).toEqual([]);
    } finally {
      await off.close();
    }
  });

  it('enabling a route on a kind that became unavailable → 409', async () => {
    // Slack was available when the channel was created, then removed from ALERT_CHANNELS.
    const o = org;
    const ch = await connectSlack('later-off');
    const prev = api.deps.env.alerts;
    (api.deps.env as { alerts: unknown }).alerts = { ...prev, slack: false };
    try {
      const r = await api.req('PUT', brandUrl(), {
        cookie: o.admin.cookie,
        body: {
          settings: SETTINGS,
          routes: [{ alertType: 'negative_spike', channelId: ch.id, enabled: true }],
        },
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('alerts_unavailable');
    } finally {
      (api.deps.env as { alerts: unknown }).alerts = prev;
    }
  });
});

function spikePayload(): AlertPayload {
  return {
    kind: 'spike',
    negatives: 12,
    total: 40,
    expectedPerHour: 2,
    trigger: 'volume',
    sensitivity: 'high',
    minCount: 5,
    commentIds: [],
    connectionIds: [],
    connectionCount: 0,
  };
}
