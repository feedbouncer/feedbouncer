import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertsNavLink } from './alerts-nav-link';

describe('AlertsNavLink', () => {
  it('nav shows Alerts for admin, hides for member', () => {
    const show = (role: 'owner' | 'admin' | 'member') =>
      renderToStaticMarkup(<AlertsNavLink role={role} href="/orgs/o/alerts" />);
    expect(show('admin')).toContain('href="/orgs/o/alerts"');
    expect(show('admin')).toContain('Alerts');
    expect(show('owner')).toContain('Alerts');
    expect(show('member')).toBe('');
  });
});
