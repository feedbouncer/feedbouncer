import { expect, test } from 'vitest';
import { tagComment } from './tags.js';

test('tagComment', () => {
  expect(tagComment('DM me to invest in BTC', null, 'Acme')).toEqual(['crypto_investment']);
  expect(tagComment('claim your prize at bit.ly/x', 'Acme Support', 'Acme')).toEqual(
    expect.arrayContaining(['phishing_link', 'fake_giveaway', 'impersonation']),
  );
  expect(tagComment('buy followers', null, 'Acme')).toEqual(['generic']);
});

test('impersonation needs a page name of at least 3 characters', () =>
  expect(tagComment('hello there', 'Al Smith', 'Al')).toEqual(['generic']));
