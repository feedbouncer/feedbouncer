import { describe, expect, it } from 'vitest';
import { parseAd } from './ads.js';

const base = {
  id: '120000000000001',
  account_id: '1001',
  effective_status: 'ACTIVE',
  updated_time: '2026-10-14T10:00:00+0000',
};
const place = (r: ReturnType<typeof parseAd>, p: 'facebook' | 'instagram') =>
  'skipped' in r ? null : r.ad!.placements.find((x) => x.platform === p);

describe('parseAd', () => {
  it('resolves a facebook dark post', () => {
    const r = parseAd({
      ...base,
      creative: { id: '7', effective_object_story_id: '900_123', object_type: 'SHARE' },
    });
    expect(place(r, 'facebook')).toEqual({
      platform: 'facebook',
      accountExternalId: '900',
      sourceExternalId: '900_123',
      unresolvedReason: null,
    });
    expect(place(r, 'instagram')).toMatchObject({ unresolvedReason: 'not_instagram' });
  });
  it('resolves both placements', () => {
    const r = parseAd({
      ...base,
      creative: {
        id: '7',
        effective_object_story_id: '900_123',
        effective_instagram_media_id: '17900000000000001',
        instagram_user_id: '17841400000000001',
      },
    });
    expect(place(r, 'instagram')).toEqual({
      platform: 'instagram',
      accountExternalId: '17841400000000001',
      sourceExternalId: '17900000000000001',
      unresolvedReason: null,
    });
  });
  it('marks a lagging instagram media id as pending', () => {
    expect(
      place(
        parseAd({ ...base, creative: { id: '7', instagram_user_id: '17841400000000001' } }),
        'instagram',
      ),
    ).toMatchObject({ sourceExternalId: null, unresolvedReason: 'instagram_media_pending' });
  });
  it('keeps a deleted post deleted on both platforms when a media id existed', () => {
    const r = parseAd({
      ...base,
      creative: { id: '7', object_type: 'POST_DELETED', effective_instagram_media_id: '179' },
    });
    expect(place(r, 'instagram')).toMatchObject({ unresolvedReason: 'post_deleted' });
  });
  it.each([
    [{ effective_object_story_id: '../me/accounts' }, 'facebook', 'invalid_platform_id'],
    [{ effective_object_story_id: '900_1?fields=access_token' }, 'facebook', 'invalid_platform_id'],
    [{ effective_instagram_media_id: '1/comments' }, 'instagram', 'invalid_platform_id'],
    [{}, 'facebook', 'no_post'],
    [{ object_type: 'POST_DELETED' }, 'facebook', 'post_deleted'],
    [{ object_type: 'STORE_ITEM' }, 'facebook', 'dynamic_creative_unsupported'],
  ])('creative %j -> %s %s', (creative, p, reason) => {
    expect(
      place(parseAd({ ...base, creative: { id: '7', ...creative } }), p as 'facebook'),
    ).toMatchObject({
      unresolvedReason: reason,
      sourceExternalId: null,
    });
  });
  it('skips an ad with a hostile id or status', () => {
    expect(parseAd({ ...base, id: '1 OR 1=1', creative: {} })).toEqual({ skipped: 'invalid_ad' });
    expect(parseAd({ ...base, account_id: 'act_../x', creative: {} })).toEqual({
      skipped: 'invalid_ad',
    });
    expect(parseAd({ ...base, effective_status: '<script>', creative: {} })).toEqual({
      skipped: 'invalid_ad',
    });
  });
  it('active follows effective_status', () => {
    const r = parseAd({ ...base, effective_status: 'PAUSED', creative: { id: '7' } });
    expect('skipped' in r ? null : r.active).toBe(false);
  });
});
