import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReplyAvailability } from '../../lib/org-comments';
import { ReplyComposer } from './reply-composer';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const render = (reply: ReplyAvailability, canManageConnections = true, platform = 'instagram') =>
  renderToStaticMarkup(
    <ReplyComposer
      orgId="o1"
      comment={{ id: 'c1', platform, brandId: 'b1' }}
      reply={reply}
      canManageConnections={canManageConnections}
    />,
  );

const no = (reason: string): ReplyAvailability => ({ available: false, reason });

/** The opening tag of the first `tag` element. */
const openTag = (html: string, tag: string) => {
  const start = html.indexOf(`<${tag}`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('>', start) + 1);
};

describe('ReplyComposer', () => {
  it('unavailable reasons render the exact copy and a disabled textarea', () => {
    const cases: [string, string][] = [
      ['not_permitted', 'You don&#x27;t have permission to reply. Ask an owner or admin.'],
      ['unsupported', 'Replying isn&#x27;t available for Instagram comments.'],
      ['connection_needs_reconnect', 'Reconnect this Instagram account to reply.'],
      ['connection_inactive', 'This Instagram account is paused, so replies can&#x27;t be sent.'],
      [
        'reply_to_hidden_comment',
        'Instagram doesn&#x27;t allow replies to hidden comments. Unhide it first.',
      ],
    ];
    for (const [reason, copy] of cases) {
      const html = render(no(reason));
      expect(html).toContain(copy);
      const textarea = openTag(html, 'textarea');
      expect(textarea).toContain('disabled=""');
      const tid = /\sid="([^"]+)"/.exec(textarea)?.[1];
      expect(html).toContain(`<label for="${tid}">Reply</label>`);
      // The textarea names the reason, so a screen reader hears why it is disabled.
      const id = /aria-describedby="([^"]+)"/.exec(textarea)?.[1];
      expect(html).toContain(`id="${id}"`);
      expect(openTag(html, 'button')).toContain('disabled=""');
      expect(html).toContain('>Send reply</button>');
    }
  });

  it('reconnect link only for managers', () => {
    const manager = render(no('connection_needs_reconnect'), true);
    expect(manager).toContain('<a href="/orgs/o1/brands/b1/connections">Reconnect</a>');
    const member = render(no('connection_needs_reconnect'), false);
    expect(member).toContain('Reconnect this Instagram account to reply.');
    expect(member).not.toContain('<a');
    expect(render(no('connection_inactive'), true)).not.toContain('<a');
  });

  it('counter shows n / max', () => {
    const html = render({ available: true, maxChars: 2200 });
    expect(html).toContain('0 / 2200');
    const textarea = openTag(html, 'textarea');
    expect(textarea).not.toContain('disabled');
    expect(textarea).not.toMatch(/maxlength/i);
    expect(html).toContain('>Reply</label>');
    // Nothing typed yet, so there is nothing to send.
    expect(openTag(html, 'button')).toContain('disabled=""');
    expect(render({ available: true, maxChars: 1000 }, true, 'facebook')).toContain('0 / 1000');
  });
});
