import { TOP_ADS_LIMIT, TOP_ADS_MIN_COMMENTS } from './constants.js';
import { adName } from './format.js';
import type { AdStat } from './stats.js';

const byName = new Intl.Collator('en', { sensitivity: 'base' });

/** Highest hidden share first, compared as exact integer cross-products. */
export function rankTopAds(ads: AdStat[]): AdStat[] {
  return ads
    .filter((a) => a.total >= TOP_ADS_MIN_COMMENTS && a.hidden > 0)
    .map((a) => ({ a, name: adName(a) }))
    .sort(
      (x, y) =>
        y.a.hidden * x.a.total - x.a.hidden * y.a.total ||
        y.a.hidden - x.a.hidden ||
        byName.compare(x.name, y.name) ||
        (x.a.adId < y.a.adId ? -1 : x.a.adId > y.a.adId ? 1 : 0),
    )
    .slice(0, TOP_ADS_LIMIT)
    .map((x) => x.a);
}
