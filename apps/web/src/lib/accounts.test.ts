import { describe, expect, it } from 'vitest';
import { accountNotes, type PickerAccount } from './accounts';

describe('accountNotes', () => {
  it('tells the user how to get the Page role back', () => {
    const account: PickerAccount = {
      externalAccountId: '1',
      displayName: 'Page',
      eligible: false,
      ineligibleReason: 'insufficient_page_role',
      limitations: [],
      connection: null,
    };
    const [note] = accountNotes(account, 'facebook');
    expect(note).toContain('Moderate');
    expect(note).toContain('Page access');
  });
});
