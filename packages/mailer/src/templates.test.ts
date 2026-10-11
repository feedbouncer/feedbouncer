import { describe, expect, it } from 'vitest';
import { escapeHtml, headerSafe, renderInvitation } from './templates.js';

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
});
