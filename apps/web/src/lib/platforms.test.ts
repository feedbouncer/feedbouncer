import { describe, expect, it } from 'vitest';
import { CONNECTABLE, PLATFORM_COPY, isConnectable } from './platforms';

const KEYS = [
  'label',
  'accountNoun',
  'connectLabel',
  'viewOn',
  'deleteConfirm',
  'pickerIntro',
  'noEligible',
] as const;

describe('isConnectable', () => {
  it.each(['facebook', 'instagram', 'meta_ads', 'tiktok', 'tiktok_ads'])('accepts %s', (p) => {
    expect(isConnectable(p)).toBe(true);
  });
  it.each(['../x', 'youtube', '', 'Instagram', 'TikTok', 'constructor', '__proto__'])(
    'rejects %s',
    (p) => {
      expect(isConnectable(p)).toBe(false);
    },
  );
});

describe('PLATFORM_COPY', () => {
  it.each(CONNECTABLE)('%s has every copy key', (p) => {
    for (const k of KEYS) expect(PLATFORM_COPY[p][k].length).toBeGreaterThan(0);
  });

  it('keeps the Facebook strings', () => {
    expect(PLATFORM_COPY.facebook.connectLabel).toBe('Connect Facebook Page');
    expect(PLATFORM_COPY.facebook.viewOn).toBe('View on Facebook');
    expect(PLATFORM_COPY.facebook.deleteConfirm).toBe(
      'Delete this comment on Facebook? This cannot be undone.',
    );
  });

  it('has the TikTok copy', () => {
    expect(PLATFORM_COPY.tiktok).toMatchObject({
      label: 'TikTok account',
      connectLabel: 'Connect TikTok account',
      viewOn: 'View on TikTok',
    });
    expect(PLATFORM_COPY.tiktok_ads).toMatchObject({
      label: 'TikTok ad account',
      connectLabel: 'Connect TikTok ads',
    });
  });

  it('has the Instagram copy', () => {
    expect(PLATFORM_COPY.instagram).toEqual({
      label: 'Instagram',
      accountNoun: 'Instagram account',
      connectLabel: 'Connect Instagram account',
      pickerTitle: 'Choose Instagram accounts',
      viewOn: 'View on Instagram',
      deleteConfirm: "Delete this comment on Instagram? This can't be undone.",
      pickerIntro: 'Choose the Facebook Page your Instagram professional account is linked to.',
      noEligible:
        'None of your Facebook Pages has a linked Instagram professional account. Link your Instagram Business or Creator account to a Facebook Page in Meta Business Suite, then connect again.',
    });
  });
});
