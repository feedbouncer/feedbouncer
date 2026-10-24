import { describe, expect, it } from 'vitest';
import { world } from './test-world.js';

describe('listAccounts', () => {
  it('lists every authorised advertiser; drops a non-numeric advertiser_id', async () => {
    const { connector, oauth, tokens, advertiserId, tamper } = await world();
    tamper('/oauth2/advertiser/get/', (d) => ({
      list: [
        ...(d.list as unknown[]),
        { advertiser_id: 'bad/id', advertiser_name: 'x' },
        { advertiser_id: '42', advertiser_name: 'Second\u0000' },
      ],
    }));
    const accounts = await connector.listAccounts!(tokens.accessToken, oauth);
    expect(accounts.map((a) => [a.externalAccountId, a.displayName, a.eligible])).toEqual([
      [advertiserId, 'Acme Ads', true],
      ['42', 'Second�', true],
    ]);
    expect(accounts[0]!.accessToken).toBe(tokens.accessToken);
  });

  it('caps the list at 500 entries', async () => {
    const { connector, oauth, tokens, tamper } = await world();
    tamper('/oauth2/advertiser/get/', () => ({
      list: Array.from({ length: 501 }, (_, i) => ({
        advertiser_id: String(i),
        advertiser_name: 'n',
      })),
    }));
    await expect(connector.listAccounts!(tokens.accessToken, oauth)).rejects.toMatchObject({
      code: 'invalid_tiktok_response',
    });
  });
});
