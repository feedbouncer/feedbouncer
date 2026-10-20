import {
  CATEGORY_SLUG,
  COMMENT_STATUSES,
  LISTABLE_PLATFORMS,
  QUEUES,
  TAG_IDS_MAX,
  type Queue,
} from '@feedbouncer/actions/shared';
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
  /** The parent comment was erased or purged. */
  parentRemoved: boolean;
  ads: VisibleCommentAdDto[];
  adCount: number;
  category: string | null;
  status: string;
  stale: boolean;
  /** When and by whom the comment was marked done; null while it is open. */
  done: { at: string; byName: string | null } | null;
  tags: TagOption[];
  /** Pending and applied public replies, newest first. Text is for display only. */
  replies: CommentReplyDto[];
  replyCount: number;
  reply: ReplyAvailability;
}

export interface TagOption {
  id: string;
  name: string;
}

export interface CommentReplyDto {
  id: string;
  text: string;
  status: 'pending' | 'applied';
  actorType: string;
  authorName: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Whether the viewer can reply to a comment now, and if not, why. */
export type ReplyAvailability =
  | { available: true; maxChars: number }
  | { available: false; reason: string };

/** A public reply as the replies route returns it. */
export interface ReplyDto {
  id: string;
  status: string;
  outcomeCode: string | null;
  text: string;
  authorName: string | null;
  actorType: string;
  createdAt: string;
  completedAt: string | null;
}

export interface TagDto extends TagOption {
  commentCount: number;
  createdAt: string;
}

export interface CommentPermissions {
  reply: boolean;
  triage: boolean;
  manageTags: boolean;
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
  tags: TagOption[];
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
  queue: Queue;
  /** Tag ids; a comment must have every one. */
  tags: string[];
  /** Deep links from alerts: one brand, a posted-at range (`from` inclusive, `to` exclusive) and a signal. */
  brand: string | null;
  from: string | null;
  to: string | null;
  signal: 'negative' | null;
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
  permissions: CommentPermissions;
}

export const PAGE_SIZE = 50;
const AD_LABEL_MAX = 80;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// The API refuses wider ranges, so they are dropped here instead of failing the page.
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const isIsoUtc = (v: string) => ISO_UTC.test(v) && !Number.isNaN(new Date(v).getTime());

type Params = Record<string, string | string[] | undefined>;

export function parseSearchParams(sp: Params): {
  filters: OrgCommentFilters;
  cursor: Cursor | null;
} {
  const one = (k: string, ok: (v: string) => boolean): string | null => {
    const v = sp[k];
    return typeof v === 'string' && ok(v) ? v : null;
  };
  const tag = sp.tag;
  const tagValues = typeof tag === 'string' ? [tag] : (tag ?? []);
  const before = one('before', isIsoUtc);
  const beforeId = one('beforeId', isUuid);
  let from = one('from', isIsoUtc);
  let to = one('to', isIsoUtc);
  if (from && to) {
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > MAX_RANGE_MS) from = to = null;
  }
  return {
    filters: {
      platform: one('platform', (v) => (LISTABLE_PLATFORMS as readonly string[]).includes(v)),
      ad: one('ad', (v) => v === 'none' || isUuid(v)),
      category: one('category', (v) => v === '_none' || CATEGORY_SLUG.test(v)),
      status: one('status', (v) => (COMMENT_STATUSES as readonly string[]).includes(v)),
      queue: (one('queue', (v) => (QUEUES as readonly string[]).includes(v)) ?? 'open') as Queue,
      tags: [...new Set(tagValues.filter(isUuid).map((v) => v.toLowerCase()))].slice(
        0,
        TAG_IDS_MAX,
      ),
      brand: one('brand', isUuid)?.toLowerCase() ?? null,
      from,
      to,
      signal: one('signal', (v) => v === 'negative') as 'negative' | null,
    },
    cursor: before && beforeId ? { before, beforeId } : null,
  };
}

const SINGLE_FILTERS = [
  'platform',
  'ad',
  'category',
  'status',
  'brand',
  'from',
  'to',
  'signal',
] as const;

function query(f: OrgCommentFilters, cursor: Cursor | null | undefined): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of SINGLE_FILTERS) {
    const v = f[k];
    if (v) q.set(k, v);
  }
  if (cursor) {
    q.set('before', cursor.before);
    q.set('beforeId', cursor.beforeId);
  }
  return q;
}

/** The API's list query: the queue always, and tags as one comma-separated value. */
export function apiQuery(f: OrgCommentFilters, cursor: Cursor | null): string {
  const q = query(f, cursor);
  q.set('queue', f.queue);
  if (f.tags.length > 0) q.set('tags', f.tags.join(','));
  q.set('limit', String(PAGE_SIZE));
  return q.toString();
}

/** The page URL, as the filter form submits it: one `tag` per id, the default queue left out. */
export function pageHref(orgId: string, f: OrgCommentFilters, cursor?: Cursor | null): string {
  const p = query(f, cursor);
  if (f.queue !== 'open') p.set('queue', f.queue);
  for (const t of f.tags) p.append('tag', t);
  const q = p.toString();
  return `/orgs/${orgId}/comments${q ? `?${q}` : ''}`;
}

/** Whether any filter narrows the list; the queue is a view, not a filter. */
export const hasFilters = (f: OrgCommentFilters): boolean =>
  SINGLE_FILTERS.some((k) => f[k] !== null) || f.tags.length > 0;

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
