import {
  ScanResultV1,
  SCAN_CATEGORIES,
  type ScanBucket,
  type ScanCategory,
  type ScanNotice,
  type ScanTag,
} from './contract.js';
import {
  MAX_ADS,
  MAX_EXAMPLES_PER_CATEGORY,
  MAX_UNCERTAIN_EXAMPLES,
  MIN_RELIABLE_SAMPLE,
  WINDOW_DAYS,
} from './limits.js';
import { clipText } from './mask.js';

export type AdPostMeta = {
  ordinal: number;
  platform: 'facebook' | 'instagram';
  label: string | null;
  adCount: number;
};

export type ScannedComment = {
  adOrdinal: number;
  hidden: boolean;
  normText: string;
  text: string;
  authorLabel: string;
  bucket: ScanBucket;
  category: ScanCategory | null;
  score: number;
  reason: string;
  tags: ScanTag[];
};

const REPEAT_THRESHOLD = 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export class ResultBuilder {
  private readonly comments: ScannedComment[] = [];
  private readonly notices = new Set<ScanNotice>();

  constructor(
    private readonly posts: AdPostMeta[],
    private readonly maxComments: number,
  ) {}

  add(c: ScannedComment): void {
    this.comments.push(c);
  }

  notice(n: ScanNotice): void {
    this.notices.add(n);
  }

  build(): ScanResultV1 {
    const visible = this.comments.filter((c) => !c.hidden);
    const occurrences = new Map<string, number>();
    for (const c of visible) occurrences.set(c.normText, (occurrences.get(c.normText) ?? 0) + 1);

    const count = (bucket: ScanBucket): number => visible.filter((c) => c.bucket === bucket).length;
    const scamSpam = count('scam_spam');
    const uncertain = count('uncertain');
    const clean = count('clean');
    const classified = scamSpam + uncertain + clean;

    const perAd = this.posts
      .map((p) => {
        const own = this.comments.filter((c) => c.adOrdinal === p.ordinal);
        const shown = own.filter((c) => !c.hidden);
        const inBucket = (b: ScanBucket): number => shown.filter((c) => c.bucket === b).length;
        return {
          ordinal: p.ordinal,
          label: p.label === null ? null : clipText(p.label).slice(0, 200),
          platform: p.platform,
          adCount: p.adCount,
          scanned: shown.length,
          scamSpam: inBucket('scam_spam'),
          uncertain: inBucket('uncertain'),
          unclassified: inBucket('unclassified'),
          hiddenExcluded: own.length - shown.length,
        };
      })
      .sort((a, b) => b.scamSpam - a.scamSpam || a.ordinal - b.ordinal);

    const breakdown = SCAN_CATEGORIES.map((category) => {
      const hits = visible.filter((c) => c.bucket === 'scam_spam' && c.category === category);
      const tags: Partial<Record<ScanTag, number>> = {};
      for (const c of hits) for (const t of c.tags) tags[t] = (tags[t] ?? 0) + 1;
      return { category, count: hits.length, tags };
    }).filter((b) => b.count > 0);

    return ScanResultV1.parse({
      v: 1,
      limits: { windowDays: WINDOW_DAYS, maxAds: MAX_ADS, maxComments: this.maxComments },
      totals: {
        adsCovered: this.posts.reduce((n, p) => n + p.adCount, 0),
        postsScanned: this.posts.length,
        commentsScanned: visible.length,
        scamSpam,
        uncertain,
        clean,
        unclassified: count('unclassified'),
        hiddenExcluded: this.comments.length - visible.length,
        repeatedComments: visible.filter(
          (c) => (occurrences.get(c.normText) ?? 0) >= REPEAT_THRESHOLD,
        ).length,
      },
      sharePct: classified === 0 ? null : round1((100 * scamSpam) / classified),
      reliable: classified >= MIN_RELIABLE_SAMPLE,
      empty: visible.length === 0,
      notices: [...this.notices, 'deleted_not_visible' as const].filter(
        (n, i, all) => all.indexOf(n) === i,
      ),
      breakdown,
      perAd,
      examples: this.examples(visible, occurrences),
    });
  }

  private examples(visible: ScannedComment[], occurrences: Map<string, number>) {
    const seen = new Set<string>();
    const groups: Array<[ScanBucket, ScanCategory | null, number]> = [
      ...SCAN_CATEGORIES.map((c): [ScanBucket, ScanCategory | null, number] => [
        'scam_spam',
        c,
        MAX_EXAMPLES_PER_CATEGORY,
      ]),
      ['uncertain', null, MAX_UNCERTAIN_EXAMPLES],
    ];
    const ranked = [...visible].sort((a, b) => b.score - a.score);
    return groups.flatMap(([bucket, category, limit]) => {
      const picked: ScannedComment[] = [];
      for (const c of ranked) {
        if (picked.length === limit) break;
        if (c.bucket !== bucket || c.category === null) continue;
        if (category !== null && c.category !== category) continue;
        if (seen.has(c.normText)) continue;
        seen.add(c.normText);
        picked.push(c);
      }
      return picked.map((c) => ({
        bucket: c.bucket as 'scam_spam' | 'uncertain',
        category: c.category as ScanCategory,
        tags: c.tags,
        text: clipText(c.text),
        authorLabel: c.authorLabel,
        adOrdinal: c.adOrdinal,
        reason: c.reason.slice(0, 300),
        repeatCount: occurrences.get(c.normText) ?? 1,
      }));
    });
  }
}

export function redactForShare(r: ScanResultV1): ScanResultV1 {
  return {
    ...r,
    perAd: r.perAd.map((p) => ({ ...p, label: null })),
    examples: r.examples.map((e) => ({ ...e, authorLabel: null })),
  };
}
