import { describe, expect, it } from 'vitest';
import { escapeHtml, extractFirstUrl, headerSafe, renderInvitation } from './templates.js';

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
  it('escapes the URL attribute', () => {
    expect(escapeHtml('http://x/?a=1&b="2"')).toBe('http://x/?a=1&amp;b=&quot;2&quot;');
  });
  it('extractFirstUrl finds the link in a text body', () => {
    expect(extractFirstUrl('Click: http://localhost:3000/invite?token=a_b-c\nThanks')).toBe(
      'http://localhost:3000/invite?token=a_b-c',
    );
  });
});
