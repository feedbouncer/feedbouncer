import { describe, expect, it } from 'vitest';
import { rankTopAds } from './rank.js';
import type { AdStat } from './stats.js';

const ad = (adId: string, hidden: number, total: number, name: string | null = adId): AdStat => ({
  adId,
  externalId: `120000000${adId}`,
  name,
  platforms: ['facebook'],
  brandId: 'brand',
  archived: false,
  hidden,
  total,
});

const ids = (ads: AdStat[]) => ads.map((a) => a.adId);

describe('rankTopAds', () => {
  it('orders by share, then hidden, then name, then id', () => {
    const ranked = rankTopAds([
      ad('a1', 3, 12),
      ad('a2', 6, 24, 'B'),
      ad('a3', 5, 10),
      ad('a4', 1, 10),
      ad('a5', 6, 24, 'A'),
    ]);
    expect(ids(ranked)).toEqual(['a3', 'a5', 'a2', 'a1', 'a4']);
    const z = ad('z', 2, 10, 'Same');
    const y = ad('y', 2, 10, 'same');
    expect(ids(rankTopAds([z, y]))).toEqual(['y', 'z']);
    expect(ids(rankTopAds([y, z]))).toEqual(['y', 'z']);
  });

  it('exact rational comparison: 1/3 vs 333/1000', () => {
    expect(ids(rankTopAds([ad('b', 333, 1000), ad('a', 10, 30)]))).toEqual(['a', 'b']);
  });

  it('returns at most 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ad(`a${i}`, i + 1, 20));
    expect(ids(rankTopAds(many))).toEqual(['a7', 'a6', 'a5', 'a4', 'a3']);
  });

  it('excludes total < 10 and hidden = 0 defensively', () => {
    expect(ids(rankTopAds([ad('few', 9, 9), ad('none', 0, 50), ad('ok', 1, 10)]))).toEqual(['ok']);
  });
});
