import {
  REPORT_INCOMPLETE_ACCOUNTS_MAX,
  SECONDS_SAVED_PER_HIDDEN_COMMENT,
  TOP_ADS_MIN_COMMENTS,
} from './constants.js';
import {
  adLabel,
  formatChange,
  formatCount,
  formatDuration,
  formatPercent,
  formatRange,
  platformLabel,
  sanitizeName,
} from './format.js';
import { rankTopAds } from './rank.js';
import type { ReportBucket } from './sql.js';
import type { WeeklyStats } from './stats.js';

export const BUCKET_LABELS: Record<ReportBucket, string> = {
  spam: 'Spam',
  scam_phishing: 'Scams and phishing',
  harassment_abuse: 'Harassment and abuse',
  hate_speech: 'Hate speech',
  sexual_content: 'Sexual content',
  profanity: 'Profanity',
  self_promotion: 'Self-promotion',
  rule: 'Your rules',
  custom_policy: 'Your custom policies',
  other: 'Other',
};

/** Copy shared by the email and the Weekly report page. */
export const REPORT_HEADINGS = {
  processed: 'Comments processed',
  hidden: 'Hidden by category',
  topAds: 'Ads with the highest share of hidden comments',
  timeSaved: 'Estimated time saved',
  brands: 'By brand',
} as const;
export const TOP_ADS_COLUMNS = ['Ad', 'Platform', 'Hidden', 'Comments', 'Hidden share'] as const;
export const TOP_ADS_EXPLAINER = `Hidden share = hidden comments ÷ all comments on the ad this week. Ads with fewer than ${TOP_ADS_MIN_COMMENTS} comments are not ranked.`;
export const NONE_QUALIFY = `No ad had at least ${TOP_ADS_MIN_COMMENTS} comments with hidden ones this week, so there is no ranking.`;

/** Display-ready strings: every user-supplied name is sanitized, every number formatted. */
export interface ReportView {
  workspace: string;
  range: string;
  processedLine: string;
  changeLine: string;
  /** null when nothing was hidden. */
  categories: { label: string; count: string; share: string }[] | null;
  totalHidden: string;
  /** null when nothing was hidden. */
  topAds:
    | {
        ad: string;
        platform: string;
        hidden: string;
        total: string;
        share: string;
        archived: boolean;
      }[]
    | 'none_qualify'
    | null;
  timeSaved: string;
  timeSavedNote: string;
  /** null unless at least two brands processed comments. */
  brands: { name: string; processed: string; hidden: string }[] | null;
  /** '+k more brands' when the snapshot kept only the busiest brands, else null. */
  brandsMore: string | null;
  incomplete: string | null;
}

function topAds(s: WeeklyStats): ReportView['topAds'] {
  if (s.hidden === 0) return null;
  const ranked = rankTopAds(s.ads);
  if (ranked.length === 0) return 'none_qualify';
  return ranked.map((a) => ({
    ad: adLabel(a),
    platform: platformLabel(a.platforms),
    hidden: formatCount(a.hidden),
    total: formatCount(a.total),
    share: formatPercent(a.hidden, a.total),
    archived: a.archived,
  }));
}

function incomplete(s: WeeklyStats): string | null {
  if (s.incompleteAccountCount === 0) return null;
  const names = s.incompleteAccounts
    .slice(0, REPORT_INCOMPLETE_ACCOUNTS_MAX)
    .map((a) => sanitizeName(a.name));
  const more = s.incompleteAccountCount - names.length;
  if (more > 0) names.push(`+${formatCount(more)} more`);
  return `Some accounts were disconnected during this week, so these numbers may be incomplete: ${names.join(', ')}.`;
}

export function buildView(s: WeeklyStats, workspaceName: string): ReportView {
  const brands = s.brands.filter((b) => b.processed > 0);
  const brandsMore = s.brandCount >= 2 ? s.brandCount - brands.length : 0;
  return {
    workspace: sanitizeName(workspaceName),
    range: formatRange(s.start, s.end, s.timezone),
    processedLine: `${formatCount(s.processed)} comments processed`,
    changeLine: formatChange(s.processed, s.processedPrev),
    categories:
      s.hidden === 0
        ? null
        : s.buckets.map((b) => ({
            label: BUCKET_LABELS[b.bucket],
            count: formatCount(b.count),
            share: formatPercent(b.count, s.hidden),
          })),
    totalHidden: formatCount(s.hidden),
    topAds: topAds(s),
    timeSaved: formatDuration(s.hidden * SECONDS_SAVED_PER_HIDDEN_COMMENT),
    timeSavedNote: `Estimate based on about ${SECONDS_SAVED_PER_HIDDEN_COMMENT} seconds of manual review per hidden comment.`,
    brands:
      s.brandCount < 2
        ? null
        : brands.map((b) => ({
            name: `${sanitizeName(b.name)}${b.archived ? ' (archived)' : ''}`,
            processed: formatCount(b.processed),
            hidden: formatCount(b.hidden),
          })),
    brandsMore: brandsMore > 0 ? `+${formatCount(brandsMore)} more brands` : null,
    incomplete: incomplete(s),
  };
}
