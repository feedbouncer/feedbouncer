import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountNotes, connectRequest, type PickerAccount } from '../lib/accounts';
import { AccountPicker } from './account-picker';

const IG: PickerAccount = {
  externalAccountId: '17841400000000001',
  displayName: '@shop (via Shop Page)',
  eligible: true,
  ineligibleReason: null,
  limitations: [],
  connection: null,
};
const NO_IG: PickerAccount = {
  externalAccountId: '100000000000002',
  displayName: 'Other Page',
  eligible: false,
  ineligibleReason: 'no_linked_instagram_account',
  limitations: [],
  connection: null,
};

const render = (accounts: PickerAccount[]) =>
  renderToStaticMarkup(
    <AccountPicker orgId="o" brandId="b" platform="instagram" grantId="g" accounts={accounts} />,
  );

/** The checkbox for an account id. */
function checkbox(html: string, id: string): string {
  const at = html.indexOf(`value="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<input', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

describe('AccountPicker', () => {
  it('lists linked IG accounts and disables pages without one, with the reason', () => {
    const html = render([IG, NO_IG]);
    expect(html).toContain(
      'Choose the Facebook Page your Instagram professional account is linked to.',
    );
    expect(html).toContain('@shop (via Shop Page)');
    expect(checkbox(html, IG.externalAccountId)).not.toContain('disabled');
    expect(checkbox(html, NO_IG.externalAccountId)).toContain('disabled=""');
    expect(html).toContain('No Instagram professional account is linked to this Page');
    expect(html).toMatch(/<button type="submit"[^>]*>/);
  });

  it('when nothing is eligible shows the linking prerequisite and no connect button', () => {
    const html = render([NO_IG, { ...NO_IG, externalAccountId: '3', displayName: 'Third' }]);
    expect(html).toContain(
      'None of your Facebook Pages has a linked Instagram professional account. Link your Instagram Business or Creator account to a Facebook Page in Meta Business Suite, then connect again.',
    );
    expect(html).toMatch(/<a href="\/orgs\/o\/brands\/b\/connections">Back to connections<\/a>/);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('type="checkbox"');
  });

  it('posts accountIds to /connections/instagram/grants/<id>/connect', () => {
    expect(connectRequest('o', 'b', 'instagram', 'g-1', ['17841400000000001'])).toEqual({
      path: '/api/v1/orgs/o/brands/b/connections/instagram/grants/g-1/connect',
      body: { accountIds: ['17841400000000001'] },
    });
  });

  it('renders a display name with markup as text', () => {
    const html = render([{ ...IG, displayName: '<img src=x onerror=alert(1)>' }]);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});

describe('accountNotes', () => {
  it('explains a missing Page role and missing messaging permission', () => {
    expect(
      accountNotes(
        { ...IG, eligible: false, ineligibleReason: 'insufficient_page_role' },
        'instagram',
      ),
    ).toEqual(['You need full control or moderation access to this Page']);
    expect(
      accountNotes({ ...IG, limitations: ['messaging_permission_missing'] }, 'instagram'),
    ).toEqual(["Private replies won't be available (messaging permission not granted)"]);
  });
  it('keeps the Facebook notes', () => {
    expect(accountNotes({ ...IG, limitations: ['no_messaging_task'] }, 'facebook')).toEqual([
      "Private replies won't be available",
    ]);
    expect(accountNotes({ ...IG, connection: 'elsewhere' }, 'facebook')).toEqual([
      'Already connected in another FeedBouncer workspace.',
    ]);
  });
  it('uses the Instagram wording for an account connected elsewhere', () => {
    expect(accountNotes({ ...IG, connection: 'elsewhere' }, 'instagram')).toEqual([
      'This Instagram account is already connected in another FeedBouncer workspace.',
    ]);
  });
});
