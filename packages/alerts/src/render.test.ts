import { describe, expect, it } from 'vitest';
import { escapeHtml, headerSafe } from '@feedbouncer/mailer';
import {
  renderConfirmEmail,
  renderDisconnectEmail,
  renderEmail,
  renderEmailTest,
  renderSlack,
  renderSlackTest,
  type SlackPayload,
} from './render.js';
import { settingsLink, spikeLink, unsubscribeApiUrl, unsubscribeLink } from './links.js';
import type { AlertView } from './view.js';

const web = new URL('https://app.example.test');
const ORG = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'unsubTOKEN_unsubTOKEN_unsubTOKEN_unsubTOKEN';
// 1:30 AM EDT, then 1:30 AM EST an hour later: the end of DST in New York.
const from = new Date('2026-11-01T05:30:00.000Z');
const to = new Date('2026-11-01T06:30:00.000Z');

const spike = (o: Partial<AlertView> = {}): AlertView => ({
  type: 'negative_spike',
  organizationId: ORG,
  workspaceName: 'Acme Workspace',
  brand: { id: BRAND, name: 'Acme', timezone: 'America/New_York' },
  accounts: [
    { name: 'Acme Main', platform: 'facebook' },
    { name: 'acme.gram', platform: 'instagram' },
    { name: 'Acme TT', platform: 'tiktok' },
    { name: 'Acme Tube', platform: 'youtube' },
    { name: 'Acme X', platform: 'x' },
  ],
  moreAccounts: 2,
  window: { from, to },
  counts: { negatives: 12, total: 40, expectedPerHour: 2.04 },
  excerpts: ['This is a scam', 'Worst <service> & @here'],
  link: spikeLink(web, ORG, BRAND, from, to),
  ...o,
});

const flags = (n: number, o: Partial<AlertView> = {}): AlertView => ({
  ...spike(),
  type: 'flagged_digest',
  accounts: [{ name: 'Acme Main', platform: 'facebook' }],
  moreAccounts: 0,
  counts: { count: n },
  liveItemCount: n,
  link: `https://app.example.test/orgs/${ORG}/brands/${BRAND}/review`,
  ...o,
});

const recipient = { email: 'ops@acme.test', unsubscribeToken: TOKEN, web };
const json = (p: SlackPayload) => JSON.stringify(p);
const buttons = (p: SlackPayload) =>
  (p.blocks as { type: string; elements?: { text: { text: string }; url: string }[] }[])
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements ?? []);

describe('renderSlack', () => {
  it('spike Slack has title, brand, accounts with +k more, window in brand timezone (America/New_York across the Nov 1 2026 DST change), counts line, View comments button with spikeLink, unfurl off', () => {
    const p = renderSlack(spike());
    const s = json(p);
    expect(p.text).toBe('Negative comment spike on Acme');
    expect(s).toContain('Negative comment spike on Acme');
    expect(s).toContain(
      'Accounts: Acme Main (Facebook), acme.gram (Instagram), Acme TT (TikTok), Acme Tube (YouTube), Acme X (X), +2 more',
    );
    expect(s).toContain(
      '12 negative of 40 comments between Nov 1, 2026, 1:30 AM EDT and Nov 1, 2026, 1:30 AM EST (30%). Usual level: 2.0 per hour.',
    );
    expect(buttons(p)).toEqual([
      expect.objectContaining({
        text: expect.objectContaining({ text: 'View comments' }),
        url: spikeLink(web, ORG, BRAND, from, to),
      }),
    ]);
    expect(p.unfurl_links).toBe(false);
    expect(p.unfurl_media).toBe(false);
    expect(s).toContain('Worst &lt;service&gt; &amp; @​here');
  });

  it('spike alerts say the linked list leaves out comments already hidden or removed', () => {
    expect(json(renderSlack(spike()))).toContain(
      'The link lists only comments still visible; hidden or removed ones are counted but not shown.',
    );
  });

  it('rounds the usual level from 10 per hour', () => {
    const s = json(
      renderSlack(spike({ counts: { negatives: 30, total: 31, expectedPerHour: 12.6 } })),
    );
    expect(s).toContain('(97%). Usual level: 13 per hour.');
  });

  it('escapes brand and account names', () => {
    const s = json(
      renderSlack(
        spike({
          brand: { id: BRAND, name: '<!channel> & co', timezone: 'UTC' },
          accounts: [{ name: '@everyone <b>', platform: 'facebook' }],
          moreAccounts: 0,
        }),
      ),
    );
    expect(s).not.toContain('<!channel>');
    expect(s).toContain('&lt;!channel&gt; &amp; co');
    expect(s).toContain('Accounts: @​everyone &lt;b&gt; (Facebook)');
    expect(s).not.toContain('more');
  });

  it('escalation includes Up from N', () => {
    const p = renderSlack(
      spike({
        type: 'spike_escalation',
        counts: { negatives: 40, total: 60, expectedPerHour: 2, triggerCount: 12 },
      }),
    );
    expect(p.text).toBe('Still escalating: negative comments on Acme');
    expect(json(p)).toContain('Usual level: 2.0 per hour. Up from 12 when the alert started.');
    const e = renderEmail(
      spike({
        type: 'spike_escalation',
        counts: { negatives: 40, total: 60, expectedPerHour: 2, triggerCount: 12 },
      }),
      recipient,
    );
    expect(e.subject).toBe('Still escalating: negative comments on Acme');
    expect(e.text).toContain('Up from 12 when the alert started.');
  });

  it('flag digest singular/plural', () => {
    const one = renderSlack(flags(1));
    expect(one.text).toBe('1 flagged comment on Acme');
    expect(json(one)).toContain(
      'Flagged between Nov 1, 2026, 1:30 AM EDT and Nov 1, 2026, 1:30 AM EST.',
    );
    expect(buttons(one)).toEqual([
      expect.objectContaining({
        text: expect.objectContaining({ text: 'Open review queue' }),
        url: `https://app.example.test/orgs/${ORG}/brands/${BRAND}/review`,
      }),
    ]);
    expect(renderSlack(flags(3)).text).toBe('3 flagged comments on Acme');
    expect(renderEmail(flags(1), recipient).subject).toBe('1 flagged comment on Acme');
    expect(renderEmail(flags(2), recipient).subject).toBe('2 flagged comments on Acme');
  });

  it('counts the flags still open at render time', () => {
    expect(renderSlack(flags(5, { liveItemCount: 2 })).text).toBe('2 flagged comments on Acme');
  });

  it('cap message has no brand data', () => {
    const cap: AlertView = {
      type: 'cap_reached',
      organizationId: ORG,
      workspaceName: 'Acme Workspace',
      brand: null,
      accounts: [],
      moreAccounts: 0,
      window: null,
      counts: { cap: 20, resumesAt: Date.parse('2026-10-17T11:05:00.000Z') },
      excerpts: [],
      link: settingsLink(web, ORG),
    };
    const p = renderSlack(cap);
    expect(p.text).toBe('Alert limit reached for this workspace');
    const body =
      'More than 20 alerts were triggered in the last hour. Further alerts are paused until Oct 17, 2026, 11:05 AM UTC. Open FeedBouncer to review.';
    expect(json(p)).toContain(body);
    expect(json(p)).not.toContain('Accounts');
    expect(json(p)).not.toContain(BRAND);
    const e = renderEmail(cap, recipient);
    expect(e.subject).toBe('Alert limit reached for this workspace');
    expect(e.text).toContain(body);
    expect(e.text).not.toContain(BRAND);
    expect(e.text).toContain(`Manage alerts: ${settingsLink(web, ORG)}`);
  });
});

describe('content mode', () => {
  it('counts_only view (excerpts []) renders no comment text in Slack or email', () => {
    const withText = spike();
    const v = spike({ excerpts: [] });
    const s = json(renderSlack(v));
    const e = renderEmail(v, recipient);
    for (const x of withText.excerpts) {
      const fragment = x.slice(0, 10);
      expect(s).not.toContain(fragment);
      expect(e.text).not.toContain(fragment);
      expect(e.html).not.toContain(fragment);
    }
    expect(e.html).not.toContain('<blockquote');
  });
});

describe('renderEmail', () => {
  it("email html escapes brand name '<b>Acme & Co</b>'; subject passes headerSafe; footer has unsubscribe and manage links; List-Unsubscribe headers present", () => {
    const e = renderEmail(
      spike({ brand: { id: BRAND, name: '<b>Acme & Co</b>\r\nBcc: x@y.test', timezone: 'UTC' } }),
      recipient,
    );
    expect(e.html).not.toContain('<b>Acme');
    expect(e.html).toContain('&lt;b&gt;Acme &amp; Co&lt;/b&gt;');
    expect(e.html).toContain('Worst &lt;service&gt; &amp; @here');
    expect(e.subject).toBe(headerSafe(e.subject));
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.subject).toBe('Negative comment spike on <b>Acme & Co</b> Bcc: x@y.test');
    const unsub = unsubscribeLink(web, TOKEN);
    const manage = settingsLink(web, ORG, BRAND);
    expect(e.text).toContain(
      `You're receiving this because ops@acme.test was added to FeedBouncer alerts for Acme Workspace. Unsubscribe: ${unsub} · Manage alerts: ${manage}`,
    );
    expect(e.html).toContain(`href="${unsub}"`);
    expect(e.html).toContain(`href="${manage}"`);
    expect(e.html).toContain(`href="${escapeHtml(spikeLink(web, ORG, BRAND, from, to))}"`);
    expect(e.headers).toEqual({
      'List-Unsubscribe': `<${unsubscribeApiUrl(web, TOKEN)}>, <${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(e.text.split('\n').some((l) => l.startsWith('Bcc:'))).toBe(false);
  });
});

describe('fixed messages', () => {
  it('renders the Slack test message', () => {
    const p = renderSlackTest();
    expect(p.text).toBe('FeedBouncer test alert: this channel is connected.');
    expect(p.unfurl_links).toBe(false);
    expect(p.unfurl_media).toBe(false);
  });

  it('renders the email test message with footer and unsubscribe headers', () => {
    const e = renderEmailTest({
      email: 'ops@acme.test',
      workspaceName: '<i>WS</i>',
      unsubscribeToken: TOKEN,
      web,
      orgId: ORG,
    });
    expect(e.text).toContain('FeedBouncer test alert: this channel is connected.');
    expect(e.text).toContain(
      `added to FeedBouncer alerts for <i>WS</i>. Unsubscribe: ${unsubscribeLink(web, TOKEN)} · Manage alerts: ${settingsLink(web, ORG)}`,
    );
    expect(e.html).toContain('&lt;i&gt;WS&lt;/i&gt;');
    expect(e.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('renders the confirmation email', () => {
    const link = 'https://app.example.test/alerts/confirm?token=abcdefghijklmnop';
    const e = renderConfirmEmail({ email: 'ops@acme.test', workspaceName: 'Acme\r\nWS', link });
    expect(e.subject).toBe('Confirm FeedBouncer alerts for Acme WS');
    expect(e.text).toBe(
      `A workspace admin added ops@acme.test to FeedBouncer alerts for Acme WS. Confirm to start receiving them:\n\n${link}\n\nThe link expires in 7 days. If you didn't expect this, ignore this email.\n`,
    );
    expect(e.text).not.toContain(`${link}.`);
    expect(e.html).toContain(`href="${link}"`);
  });

  it('renders the disconnect email', () => {
    const link = `https://app.example.test/orgs/${ORG}/alerts`;
    const e = renderDisconnectEmail({
      workspaceName: 'Acme',
      label: '#ops <alerts>',
      code: 'no_service',
      link,
    });
    expect(e.subject).toBe('Slack alerts disconnected for Acme');
    expect(e.text).toContain(
      `Slack rejected alerts for "#ops <alerts>" (no_service). Alerts to this channel are stopped. Reconnect it: ${link}`,
    );
    expect(e.html).toContain('&quot;#ops &lt;alerts&gt;&quot;');
  });
});
