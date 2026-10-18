import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountNotes, canConnect, connectRequest, type PickerAccount } from '../lib/accounts';
import { AccountPicker, ReviewModeChoice } from './account-picker';

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

function inputNamed(html: string, name: string): string {
  const at = html.indexOf(`name="${name}"`);
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

  it('starts in review mode by default', () => {
    const html = render([IG]);
    expect(inputNamed(html, 'reviewMode')).toContain('checked=""');
    expect(html).toContain('Start in review mode (recommended)');
    expect(html).not.toContain('I understand. Start automation now.');
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled)/);
  });

  it('account-picker cannot submit opt-out until the risk is acknowledged and sends acknowledgeRisk', () => {
    const html = renderToStaticMarkup(
      <ReviewModeChoice on={false} acknowledged={false} onChange={() => undefined} />,
    );
    expect(html).toContain(
      'Without review mode, your rules, the classifier and your policies start hiding, deleting, banning and replying as soon as this account is connected. A mistake in a rule can affect real people before you notice. We recommend keeping review mode on for the first 7 days.',
    );
    const ack = inputNamed(html, 'acknowledgeRisk');
    expect(ack).toContain('required=""');
    expect(ack).not.toContain('checked');
    expect(html).toContain('I understand. Start automation now.');
    expect(canConnect({ on: true, acknowledged: false })).toBe(true);
    expect(canConnect({ on: false, acknowledged: false })).toBe(false);
    expect(canConnect({ on: false, acknowledged: true })).toBe(true);
    expect(
      connectRequest('o', 'b', 'facebook', 'g', ['1'], { on: false, acknowledged: true }).body,
    ).toEqual({ accountIds: ['1'], reviewMode: 'off', acknowledgeRisk: true });
    expect(
      connectRequest('o', 'b', 'facebook', 'g', ['1'], { on: true, acknowledged: true }).body,
    ).toEqual({
      accountIds: ['1'],
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
    ).toEqual([
      'You need full control of this Page, or Facebook access with the Moderate task. Ask a Page admin to grant it in Meta Business Suite → Settings → Page access, then connect again.',
    ]);
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
