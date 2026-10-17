import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AlertChannelDto } from '../../lib/alerts';
import { ChannelList } from './channel-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const ch = (over: Partial<AlertChannelDto>): AlertChannelDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'slack',
  label: 'Ops',
  status: 'active',
  health: 'active',
  hint: 'T...ABCD/B...WXYZ',
  email: null,
  lastFailureCode: null,
  lastFailureAt: null,
  disconnectedCode: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const render = (channels: AlertChannelDto[], canManage = true) =>
  renderToStaticMarkup(
    <ChannelList
      orgId="22222222-2222-4222-8222-222222222222"
      channels={channels}
      availability={{ slack: true, email: true }}
      canManage={canManage}
    />,
  );

describe('ChannelList', () => {
  it('badges per health, reconnect form only for disconnected, no URL rendered', () => {
    const html = render([
      ch({ id: 'a1111111-1111-4111-8111-111111111111', label: 'One' }),
      ch({
        id: 'b1111111-1111-4111-8111-111111111111',
        label: 'Two',
        health: 'delivery_problem',
        lastFailureCode: 'rate_limited',
      }),
      ch({
        id: 'c1111111-1111-4111-8111-111111111111',
        label: 'Three',
        status: 'disconnected',
        health: 'disconnected',
        disconnectedCode: 'no_service',
      }),
      ch({
        id: 'd1111111-1111-4111-8111-111111111111',
        kind: 'email',
        label: 'Mail',
        email: 'a@example.com',
        hint: null,
        status: 'pending_confirmation',
        health: 'pending_confirmation',
      }),
      ch({
        id: 'e1111111-1111-4111-8111-111111111111',
        kind: 'email',
        label: 'Gone',
        email: 'b@example.com',
        hint: null,
        status: 'unsubscribed',
        health: 'unsubscribed',
      }),
    ]);
    expect(html).toContain('Active');
    expect(html).toContain('Delivery problem: Slack is rate limiting messages.');
    expect(html).toContain('Disconnected: Slack no longer accepts this webhook.');
    expect(html).toContain('Waiting for confirmation');
    expect(html).toContain('Unsubscribed');
    expect(html.match(/Reconnect/g)).toHaveLength(1);
    expect(html).toContain('Resend');
    expect(html).toContain('Send test');
    expect(html).toContain('Remove');
    expect(html).toContain('Connect Slack');
    expect(html).toContain('Add recipient');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).not.toMatch(/https?:\/\/hooks\.slack/);
  });

  it('renders user text as text and hides management for read-only roles', () => {
    const html = render([ch({ label: '<img src=x onerror=alert(1)>' })], false);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('Connect Slack');
    expect(html).not.toContain('Send test');
  });
});
