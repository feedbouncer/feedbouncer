import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountHealthDto } from '../../lib/org-comments';
import { AccountNotices } from './account-notices';

const acct = (o: Partial<AccountHealthDto>): AccountHealthDto => ({
  connectionId: 'c1',
  brandId: 'b1',
  brandName: 'Acme',
  platform: 'instagram',
  displayName: 'acme_ig',
  problem: 'reconnect_required',
  lastSyncedAt: null,
  ...o,
});

const render = (accounts: AccountHealthDto[], canManage: boolean) =>
  renderToStaticMarkup(<AccountNotices orgId="o1" accounts={accounts} canManage={canManage} />);

describe('AccountNotices', () => {
  it('links managers to the brand connections page and tells members to ask an admin', () => {
    const accounts = [acct({})];
    const m = render(accounts, true);
    expect(m).toContain('role="status"');
    expect(m).toContain('href="/orgs/o1/brands/b1/connections"');
    expect(m).toContain('>Reconnect</a>');
    const member = render(accounts, false);
    expect(member).toContain('Ask an admin to reconnect it.');
    expect(member).not.toContain('<a');
  });

  it('shows one line per account with a problem, and nothing otherwise', () => {
    expect(render([acct({ problem: null })], true)).toBe('');
    const html = render([acct({ problem: 'sync_failing' }), acct({ connectionId: 'c2' })], true);
    expect(html.match(/role="status"/g)).toHaveLength(2);
    expect(html).toContain('We couldn&#x27;t sync Instagram account');
  });

  it('escapes names', () => {
    expect(render([acct({ displayName: '<b>x</b>' })], true)).not.toContain('<b>');
  });
});
