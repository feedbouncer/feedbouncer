import { CATEGORY_SLUG, COMMENT_STATUSES, LISTABLE_PLATFORMS } from '@feedbouncer/actions/shared';
import { platformLabel } from './actions';
import { CATEGORY_LABEL, type Category } from './classifier';
import { isUuid } from './ids';

export interface VisibleCommentAdDto {
  adId: string;
  externalId: string;
  name: string | null;
  deleted: boolean;
}

export interface VisibleCommentDto {
  id: string;
  brandId: string;
  brandName: string;
  connectionId: string;
  connectionName: string | null;
  platform: string;
  authorName: string | null;
  body: string;
  postedAt: string;
  permalink: string | null;
  isReply: boolean;
  ads: VisibleCommentAdDto[];
  adCount: number;
  category: string | null;
  status: string;
  stale: boolean;
}

export interface AdOptionDto extends VisibleCommentAdDto {
  adAccountExternalId: string;
  brandName: string;
  platforms: string[];
}

export interface FilterOptionsDto {
  platforms: string[];
  ads: AdOptionDto[];
  adsTruncated: boolean;
  categories: string[];
  statuses: readonly string[];
}

export interface AccountHealthDto {
  connectionId: string;
  brandId: string;
  brandName: string;
  platform: string;
  displayName: string | null;
  problem: 'reconnect_required' | 'sync_failing' | null;
  lastSyncedAt: string | null;
}

export interface OrgCommentFilters {
  platform: string | null;
  ad: string | null;
  category: string | null;
  status: string | null;
}

export interface Cursor {
  before: string;
  beforeId: string;
}

export interface CommentsPageDto {
  items: VisibleCommentDto[];
  next: Cursor | null;
  total: number;
  applied: OrgCommentFilters;
}

export interface CommentFiltersDto {
  options: FilterOptionsDto;
  accounts: AccountHealthDto[];
  lastSyncedAt: string | null;
  canManageConnections: boolean;
}

export const PAGE_SIZE = 50;
const AD_LABEL_MAX = 80;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

type Params = Record<string, string | string[] | undefined>;

export function parseSearchParams(sp: Params): {
  filters: OrgCommentFilters;
  cursor: Cursor | null;
} {
  const one = (k: string, ok: (v: string) => boolean): string | null => {
    const v = sp[k];
    return typeof v === 'string' && ok(v) ? v : null;
  };
  const before = one('before', (v) => ISO_UTC.test(v) && !Number.isNaN(new Date(v).getTime()));
  const beforeId = one('beforeId', isUuid);
  return {
    filters: {
      platform: one('platform', (v) => (LISTABLE_PLATFORMS as readonly string[]).includes(v)),
      ad: one('ad', (v) => v === 'none' || isUuid(v)),
      category: one('category', (v) => v === '_none' || CATEGORY_SLUG.test(v)),
      status: one('status', (v) => (COMMENT_STATUSES as readonly string[]).includes(v)),
    },
    cursor: before && beforeId ? { before, beforeId } : null,
  };
}

function query(f: OrgCommentFilters, cursor: Cursor | null | undefined): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  if (cursor) {
    q.set('before', cursor.before);
    q.set('beforeId', cursor.beforeId);
  }
  return q;
}

export function apiQuery(f: OrgCommentFilters, cursor: Cursor | null): string {
  const q = query(f, cursor);
  q.set('limit', String(PAGE_SIZE));
  return q.toString();
}

export function pageHref(orgId: string, f: OrgCommentFilters, cursor?: Cursor | null): string {
  const q = query(f, cursor).toString();
  return `/orgs/${orgId}/comments${q ? `?${q}` : ''}`;
}

export const hasFilters = (f: OrgCommentFilters): boolean => Object.values(f).some(Boolean);

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  flagged: 'Flagged',
  awaiting_action: 'Awaiting action',
  reviewed: 'Reviewed',
};

export const statusLabel = (s: string): string =>
  Object.hasOwn(STATUS_LABEL, s) ? STATUS_LABEL[s]! : 'Unknown status';

export function categoryLabel(c: string | null): string {
  if (c === null) return 'Uncategorized';
  if (Object.hasOwn(CATEGORY_LABEL, c)) return CATEGORY_LABEL[c as Category];
  const words = c.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function adLabel(a: VisibleCommentAdDto): string {
  if (a.deleted) return 'Deleted ad';
  const name = a.name?.trim();
  if (!name) return `Ad ${a.externalId}`;
  const chars = Array.from(name);
  return chars.length > AD_LABEL_MAX ? `${chars.slice(0, AD_LABEL_MAX).join('')}…` : name;
}

/** Option text per ad id; names that collide get the platforms and brand appended. */
export function adOptionLabels(ads: AdOptionDto[]): Map<string, string> {
  const key = (l: string) => l.trim().toLowerCase();
  const base = ads.map((a) => adLabel(a));
  const counts = new Map<string, number>();
  for (const l of base) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);
  return new Map(
    ads.map((a, i) => {
      const label = base[i]!;
      const suffix =
        counts.get(key(label))! > 1
          ? ` · ${a.platforms.map(platformLabel).join(' + ')} · ${a.brandName}`
          : '';
      return [a.adId, label + suffix];
    }),
  );
}

export function rowAdLabel(c: { ads: VisibleCommentAdDto[]; adCount: number }): string {
  const first = c.ads[0];
  if (!first) return 'Not on an ad';
  return c.adCount > 1 ? `${adLabel(first)} +${c.adCount - 1} more` : adLabel(first);
}

export function noticeText(a: AccountHealthDto): string | null {
  const who = `${platformLabel(a.platform)} account "${a.displayName ?? 'Unnamed account'}" (${a.brandName})`;
  if (a.problem === 'reconnect_required')
    return `${who} needs to be reconnected. Comments from it may be out of date.`;
  if (a.problem === 'sync_failing')
    return `We couldn't sync ${who} recently. Comments from it may be out of date.`;
  return null;
}

export const totalText = (n: number): string => `${n} ${n === 1 ? 'comment' : 'comments'}`;
