import type { ScanResultV1 } from '@feedbouncer/scan/contract';

export function sampleResult(over: Partial<ScanResultV1> = {}): ScanResultV1 {
  return {
    v: 1,
    limits: { windowDays: 30, maxAds: 25, maxComments: 2000 },
    totals: {
      adsCovered: 2,
      postsScanned: 2,
      commentsScanned: 200,
      scamSpam: 40,
      uncertain: 5,
      clean: 150,
      unclassified: 3,
      hiddenExcluded: 2,
      repeatedComments: 0,
    },
    sharePct: 20,
    reliable: true,
    empty: false,
    notices: [],
    breakdown: [{ category: 'spam', count: 40, tags: { phishing_link: 12, generic: 28 } }],
    perAd: [
      {
        ordinal: 1,
        label: 'Summer sale',
        platform: 'facebook',
        adCount: 1,
        scanned: 100,
        scamSpam: 20,
        uncertain: 2,
        unclassified: 1,
        hiddenExcluded: 1,
      },
    ],
    examples: [
      {
        bucket: 'scam_spam',
        category: 'spam',
        tags: ['generic'],
        text: 'Win a free phone',
        authorLabel: 'Jo***',
        adOrdinal: 1,
        reason: 'Promotes an unrelated offer',
        repeatCount: 3,
      },
    ],
    ...over,
  };
}
