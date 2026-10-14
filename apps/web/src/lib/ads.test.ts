import { describe, expect, it } from 'vitest';
import { adBadgeTitle, resolutionText } from './ads';

const ALL = [
  'linked',
  'no_post',
  'dynamic_creative_unsupported',
  'post_deleted',
  'invalid_platform_id',
  'page_not_connected',
  'not_instagram',
  'instagram_media_pending',
  'instagram_account_not_connected',
];

describe('resolutionText', () => {
  it('has copy for every resolution', () => {
    for (const r of ALL) expect(resolutionText(r)).not.toBe('Unknown reason');
  });
  it('falls back for unknown values and inherited keys', () => {
    expect(resolutionText('<img onerror=x>')).toBe('Unknown reason');
    expect(resolutionText('constructor')).toBe('Unknown reason');
  });
});

describe('adBadgeTitle', () => {
  it('names the ad and its account', () => {
    expect(adBadgeTitle({ adId: '55', adAccountId: '1001' })).toBe('Ad 55 · account 1001');
  });
});
