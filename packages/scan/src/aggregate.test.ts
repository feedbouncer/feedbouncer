import { describe, expect, test } from 'vitest';
import { redactForShare, ResultBuilder, type ScannedComment } from './aggregate.js';
import { ScanResultV1 } from './contract.js';

type Spec = [ScannedComment['bucket'], number];
const posts = [
  { ordinal: 1, platform: 'facebook' as const, label: 'Spring sale', adCount: 2 },
  { ordinal: 2, platform: 'instagram' as const, label: null, adCount: 1 },
];
const comment = (over: Partial<ScannedComment> = {}): ScannedComment => ({
  adOrdinal: 1,
  hidden: false,
  normText: 'text',
  text: 'text',
  authorLabel: 'J. D.',
  bucket: 'clean',
  category: null,
  score: 0,
  reason: '',
  tags: [],
  ...over,
});
let seq = 0;
function builderWith(specs: Spec[], opts: { hidden?: number } = {}): ResultBuilder {
  const b = new ResultBuilder(posts, 400);
  for (const [bucket, n] of specs)
    for (let i = 0; i < n; i++) {
      const t = `${bucket} ${seq++}`;
      b.add(
        comment({
          bucket,
          normText: t,
          text: t,
          category: bucket === 'scam_spam' || bucket === 'uncertain' ? 'spam' : null,
          score: 0.9,
        }),
      );
    }
  for (let i = 0; i < (opts.hidden ?? 0); i++) b.add(comment({ hidden: true }));
  return b;
}

describe('ResultBuilder', () => {
  test('headline excludes unclassified from both sides and keeps uncertain in the denominator', () => {
    const r = builderWith([
      ['scam_spam', 6],
      ['uncertain', 4],
      ['clean', 10],
      ['unclassified', 30],
    ]).build();
    expect(r.sharePct).toBe(30);
    expect(r.totals.unclassified).toBe(30);
    expect(r.reliable).toBe(true);
  });

  test('19 classified comments is not reliable', () =>
    expect(builderWith([['clean', 19]]).build().reliable).toBe(false));

  test('sharePct is rounded to one decimal', () =>
    expect(
      builderWith([
        ['scam_spam', 1],
        ['clean', 2],
      ]).build().sharePct,
    ).toBe(33.3));

  test('no visible comments gives empty and null sharePct', () => {
    const r = builderWith([], { hidden: 3 }).build();
    expect(r).toMatchObject({ empty: true, sharePct: null, totals: { hiddenExcluded: 3 } });
    expect(r.perAd[0]).toMatchObject({ ordinal: 1, hiddenExcluded: 3 });
  });

  test('hidden comments never reach a bucket', () => {
    const b = new ResultBuilder(posts, 400);
    b.add(comment({ hidden: true, bucket: 'scam_spam', category: 'spam', score: 1 }));
    const r = b.build();
    expect(r.totals).toMatchObject({ scamSpam: 0, hiddenExcluded: 1, commentsScanned: 0 });
    expect(r.examples).toEqual([]);
  });

  test('same text from 5 comments counts 5 times with one example of repeatCount 5', () => {
    const b = new ResultBuilder(posts, 400);
    for (let i = 0; i < 5; i++)
      b.add(comment({ bucket: 'scam_spam', category: 'spam', score: 0.9, normText: 'buy now' }));
    const r = b.build();
    expect(r.totals).toMatchObject({ scamSpam: 5, repeatedComments: 5 });
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({ repeatCount: 5, bucket: 'scam_spam' });
  });

  test('examples are ordered by score, deduplicated and capped per bucket', () => {
    const b = new ResultBuilder(posts, 400);
    for (let i = 0; i < 6; i++)
      b.add(
        comment({
          bucket: 'scam_spam',
          category: 'scam_phishing',
          score: 0.8 + i / 100,
          normText: `s${i}`,
          text: `s${i}`,
        }),
      );
    for (let i = 0; i < 5; i++)
      b.add(
        comment({
          bucket: 'uncertain',
          category: 'spam',
          score: 0.5 + i / 100,
          normText: `u${i}`,
          text: `u${i}`,
        }),
      );
    const r = b.build();
    expect(r.examples.map((e) => e.text)).toEqual(['s5', 's4', 's3', 'u4', 'u3', 'u2']);
  });

  test('examples never exceed 280 code points and at most 9 are kept', () => {
    const b = new ResultBuilder(posts, 400);
    for (const category of ['scam_phishing', 'spam'] as const)
      for (let i = 0; i < 5; i++)
        b.add(
          comment({
            bucket: i < 4 ? 'scam_spam' : 'uncertain',
            category,
            score: 0.9,
            normText: `${category}${i}`,
            text: '😀'.repeat(500),
          }),
        );
    const r = b.build();
    expect(r.examples.length).toBeLessThanOrEqual(9);
    for (const e of r.examples) expect([...e.text].length).toBeLessThanOrEqual(281);
  });

  test('perAd is sorted by scamSpam then ordinal, and notices include deleted_not_visible', () => {
    const b = new ResultBuilder(posts, 400);
    b.add(comment({ adOrdinal: 2, bucket: 'scam_spam', category: 'spam', score: 0.9 }));
    b.notice('sampled_time_limit');
    const r = b.build();
    expect(r.perAd.map((p) => p.ordinal)).toEqual([2, 1]);
    expect(r.notices).toEqual(['sampled_time_limit', 'deleted_not_visible']);
    expect(r.totals).toMatchObject({ adsCovered: 3, postsScanned: 2 });
    expect(r.limits).toEqual({ windowDays: 30, maxAds: 25, maxComments: 400 });
  });

  test('breakdown counts categories and tags', () => {
    const b = new ResultBuilder(posts, 400);
    b.add(
      comment({
        bucket: 'scam_spam',
        category: 'scam_phishing',
        score: 0.9,
        tags: ['phishing_link', 'generic'],
      }),
    );
    expect(b.build().breakdown).toEqual([
      { category: 'scam_phishing', count: 1, tags: { phishing_link: 1, generic: 1 } },
    ]);
  });
});

test('redactForShare nulls ad labels and keeps counts', () => {
  const r = builderWith([['scam_spam', 2]]).build();
  const red = redactForShare(r);
  expect(red.perAd.every((p) => p.label === null)).toBe(true);
  expect(red.totals).toEqual(r.totals);
  expect(ScanResultV1.safeParse(red).success).toBe(true);
});
