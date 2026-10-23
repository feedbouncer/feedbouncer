import { z } from 'zod';

export const SCAN_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export const SCAN_FAILURES = [
  'access_revoked',
  'missing_permissions',
  'insufficient_page_role',
  'rate_limited',
  'platform_unavailable',
  'classifier_unavailable',
  'timeout',
  'internal',
] as const;
export const SCAN_BUCKETS = ['scam_spam', 'uncertain', 'clean', 'unclassified'] as const;
export const SCAN_CATEGORIES = ['scam_phishing', 'spam'] as const;
export const SCAN_TAGS = [
  'crypto_investment',
  'fake_giveaway',
  'phishing_link',
  'impersonation',
  'generic',
] as const;
export const SCAN_NOTICES = [
  'sampled_comment_cap',
  'sampled_time_limit',
  'partial_rate_limited',
  'partial_platform_unavailable',
  'instagram_not_included',
  'deleted_not_visible',
] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];
export type ScanFailure = (typeof SCAN_FAILURES)[number];
export type ScanBucket = (typeof SCAN_BUCKETS)[number];
export type ScanCategory = (typeof SCAN_CATEGORIES)[number];
export type ScanTag = (typeof SCAN_TAGS)[number];
export type ScanNotice = (typeof SCAN_NOTICES)[number];

const count = z.int().nonnegative();

export const ScanResultV1 = z.strictObject({
  v: z.literal(1),
  limits: z.strictObject({ windowDays: z.int(), maxAds: z.int(), maxComments: z.int() }),
  totals: z.strictObject({
    adsCovered: count,
    postsScanned: count,
    commentsScanned: count,
    scamSpam: count,
    uncertain: count,
    clean: count,
    unclassified: count,
    hiddenExcluded: count,
    repeatedComments: count,
  }),
  sharePct: z.number().min(0).max(100).nullable(),
  reliable: z.boolean(),
  empty: z.boolean(),
  notices: z.array(z.enum(SCAN_NOTICES)),
  breakdown: z.array(
    z.strictObject({
      category: z.enum(SCAN_CATEGORIES),
      count,
      tags: z.partialRecord(z.enum(SCAN_TAGS), count),
    }),
  ),
  perAd: z
    .array(
      z.strictObject({
        ordinal: z.int().positive(),
        label: z.string().max(200).nullable(),
        platform: z.enum(['facebook', 'instagram']),
        adCount: count,
        scanned: count,
        scamSpam: count,
        uncertain: count,
        unclassified: count,
        hiddenExcluded: count,
      }),
    )
    .max(25),
  examples: z
    .array(
      z.strictObject({
        bucket: z.enum(['scam_spam', 'uncertain']),
        category: z.enum(SCAN_CATEGORIES),
        tags: z.array(z.enum(SCAN_TAGS)),
        text: z.string().max(1200),
        authorLabel: z.string().max(12),
        adOrdinal: z.int().positive(),
        reason: z.string().max(300),
        repeatCount: z.int().positive(),
      }),
    )
    .max(9),
});
export type ScanResultV1 = z.infer<typeof ScanResultV1>;

export type ScanView = {
  id: string;
  status: ScanStatus;
  failureReason: ScanFailure | null;
  pageName: string;
  createdAt: string;
  finishedAt: string | null;
  shared: boolean;
  result: ScanResultV1 | null;
};
export type SharedScanView = { pageName: string; finishedAt: string; result: ScanResultV1 };
export type ScanPageOption = {
  pageId: string;
  name: string;
  igUserId: string | null;
  igUsername: string | null;
  eligible: boolean;
  ineligibleReason: 'insufficient_page_role' | null;
};
