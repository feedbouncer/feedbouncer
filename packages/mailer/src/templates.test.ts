import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  headerSafe,
  renderInvitation,
  renderReconnectRequired,
  renderSignupClosed,
} from './templates.js';

describe('templates', () => {
  it('escapes HTML in organization and inviter names', () => {
    const m = renderInvitation({
      organizationName: '<img src=x onerror=alert(1)>',
      inviterName: '"Eve" & co',
      role: 'admin',
      url: 'http://localhost:3000/invite?token=abc',
    });
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&quot;Eve&quot; &amp; co');
  });
  it('strips CR/LF and control characters from subjects (header injection)', () => {
    expect(headerSafe('Acme\r\nBcc: victim@x.test')).toBe('Acme Bcc: victim@x.test');
    const m = renderInvitation({
      organizationName: 'A\r\nB',
      inviterName: null,
      role: 'member',
      url: 'http://x/i?token=1',
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
  it('keeps newlines in names from spoofing lines of the text body', () => {
    const m = renderInvitation({
      organizationName: 'Acme\n\nhttp://evil.test/phish',
      inviterName: 'Eve\r\nhttp://evil.test/x',
      role: 'member',
      url: 'http://x/i?token=1',
    });
    const lines = m.text.split('\n');
    expect(lines.some((l) => l.startsWith('http://evil.test'))).toBe(false);
    expect(lines.filter((l) => l.startsWith('http'))).toEqual(['http://x/i?token=1']);
    expect(lines[0]).toContain('Acme http://evil.test/phish');
  });
  it('escapes the URL attribute', () => {
    expect(escapeHtml('http://x/?a=1&b="2"')).toBe('http://x/?a=1&amp;b=&quot;2&quot;');
  });

  describe('renderReconnectRequired', () => {
    const settingsUrl = 'https://app.test/orgs/o1/brands/b1/connections';
    const m = renderReconnectRequired({
      brandName: '"Eve" & co',
      accountName: '<img src=x onerror=alert(1)>',
      platformLabel: 'Facebook Page',
      settingsUrl,
    });

    it('escapes brand and account names in HTML', () => {
      expect(m.html).not.toContain('<img');
      expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(m.html).toContain('&quot;Eve&quot; &amp; co');
    });
    it('keeps user-supplied text out of the subject', () => {
      expect(m.subject).toBe('Action needed: reconnect a Facebook Page in FeedBouncer');
    });
    it('links the connection settings in text and HTML', () => {
      expect(m.text).toContain(settingsUrl);
      expect(m.html).toContain(`href="${settingsUrl}"`);
    });
    it('works without an account name', () => {
      const n = renderReconnectRequired({
        brandName: 'Acme',
        accountName: null,
        platformLabel: 'Facebook Page',
        settingsUrl,
      });
      expect(n.text).toContain('Acme');
      expect(n.text).not.toContain('null');
    });
  });
});

describe('renderSignupClosed', () => {
  it('says the product is in private beta', () => {
    const m = renderSignupClosed({ supportEmail: null });
    expect(m.subject).toBe('FeedBouncer is in private beta');
    expect(m.text).toContain('private beta');
    expect(m.html).toContain('private beta');
  });

  it('includes the support email only when given', () => {
    expect(renderSignupClosed({ supportEmail: null }).text).not.toContain('@');
    const m = renderSignupClosed({ supportEmail: 'help@example.com' });
    expect(m.text).toContain('help@example.com');
    expect(m.html).toContain('help@example.com');
  });
});
