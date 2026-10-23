import { expect, test } from 'vitest';
import { missingScopes, SCAN_OPTIONAL_SCOPES, SCAN_REQUIRED_SCOPES } from './scopes.js';

test('missingScopes ignores optional and unknown scopes', () =>
  expect(missingScopes(['pages_show_list', 'ads_read', 'instagram_basic', 'evil'])).toEqual([
    'pages_read_engagement',
    'pages_read_user_content',
  ]));

test('scope lists', () => {
  expect(SCAN_REQUIRED_SCOPES).toEqual([
    'pages_show_list',
    'pages_read_engagement',
    'pages_read_user_content',
    'ads_read',
  ]);
  expect(SCAN_OPTIONAL_SCOPES).toEqual(['instagram_basic', 'instagram_manage_comments']);
});
