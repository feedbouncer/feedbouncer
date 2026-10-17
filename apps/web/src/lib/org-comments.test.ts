import { COMMENT_STATUSES } from '@feedbouncer/actions/shared';
import { describe, expect, it } from 'vitest';
import {
  adOptionLabels,
  apiQuery,
  categoryLabel,
  hasFilters,
  noticeText,
  pageHref,
  parseSearchParams,
  rowAdLabel,
  statusLabel,
  totalText,
  type AccountHealthDto,
  type AdOptionDto,
  type OrgCommentFilters,
} from './org-comments';

const ID = '3f9a1c52-8d1e-4b6a-9c3f-2a7b5e4d1c60';
const NONE: OrgCommentFilters = {
  platform: null,
  ad: null,
  category: null,
  status: null,
  queue: 'open',
  tags: [],
};
const ISO = '2026-10-27T10:00:00.000Z';

const ad = (o: Partial<AdOptionDto> & { adId: string }): AdOptionDto => ({
  externalId: '123',
  name: 'Spring sale',
  deleted: false,
  adAccountExternalId: 'act_1',
  brandName: 'Acme',
  platforms: ['facebook'],
  ...o,
});

describe('parseSearchParams', () => {
  it('drops malformed values', () => {
    const r = parseSearchParams({
      platform: 'meta_ads',
      ad: 'abc',
      category: 'Spam!',
      status: 'hidden',
      before: ISO,
    });
    expect(r.filters).toEqual(NONE);
    expect(r.cursor).toBeNull();
    expect(parseSearchParams({ platform: ['facebook', 'x'], status: ['new'] }).filters).toEqual(
      NONE,
    );
    expect(parseSearchParams({ beforeId: ID }).cursor).toBeNull();
    expect(parseSearchParams({ before: 'yesterday', beforeId: ID }).cursor).toBeNull();
  });

  it('keeps valid values, ad=none and category=_none', () => {
    expect(
      parseSearchParams({ platform: 'instagram', ad: 'none', category: '_none', status: 'new' })
        .filters,
    ).toEqual({ ...NONE, platform: 'instagram', ad: 'none', category: '_none', status: 'new' });
    expect(parseSearchParams({ ad: ID, category: 'brand_new_cat' }).filters).toMatchObject({
      ad: ID,
      category: 'brand_new_cat',
    });
    expect(parseSearchParams({ before: ISO, beforeId: ID }).cursor).toEqual({
      before: ISO,
      beforeId: ID,
    });
  });
});

describe('queue and tags', () => {
  const T = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('parseSearchParams: queue default open, invalid queue → open, tag array dedup and cap 10, malformed tag dropped', () => {
    expect(parseSearchParams({}).filters.queue).toBe('open');
    expect(parseSearchParams({ queue: 'done' }).filters.queue).toBe('done');
    expect(parseSearchParams({ queue: 'all' }).filters.queue).toBe('all');
    expect(parseSearchParams({ queue: 'closed' }).filters.queue).toBe('open');
    expect(parseSearchParams({ queue: ['done', 'all'] }).filters.queue).toBe('open');
    expect(parseSearchParams({ tag: T(1) }).filters.tags).toEqual([T(1)]);
    expect(
      parseSearchParams({ tag: [T(1), 'nope', T(2), T(1), T(2).toUpperCase(), ''] }).filters.tags,
    ).toEqual([T(1), T(2)]);
    const many = Array.from({ length: 14 }, (_, i) => T(i));
    expect(parseSearchParams({ tag: many }).filters.tags).toEqual(many.slice(0, 10));
    expect(parseSearchParams({ tag: 'x,y' }).filters.tags).toEqual([]);
  });

  it('apiQuery emits queue and comma-joined tags', () => {
    const q = new URLSearchParams(apiQuery({ ...NONE, tags: [T(1), T(2)] }, null));
    expect(Object.fromEntries(q)).toEqual({ queue: 'open', tags: `${T(1)},${T(2)}`, limit: '50' });
    const done = new URLSearchParams(apiQuery({ ...NONE, queue: 'done' }, null));
    expect(Object.fromEntries(done)).toEqual({ queue: 'done', limit: '50' });
  });

  it('pageHref repeats tag', () => {
    const href = pageHref('o1', { ...NONE, queue: 'all', tags: [T(1), T(2)] });
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.getAll('tag')).toEqual([T(1), T(2)]);
    expect(q.get('queue')).toBe('all');
    expect(q.has('tags')).toBe(false);
    // The default queue is left out of the page URL.
    expect(pageHref('o1', NONE)).toBe('/orgs/o1/comments');
  });

  it('hasFilters counts tags but not the queue', () => {
    expect(hasFilters({ ...NONE, queue: 'done' })).toBe(false);
    expect(hasFilters({ ...NONE, tags: [T(1)] })).toBe(true);
  });
});

describe('hrefs', () => {
  it('pageHref keeps filters and cursor; omitted filters are not emitted', () => {
    expect(pageHref('o1', NONE)).toBe('/orgs/o1/comments');
    expect(pageHref('o1', { ...NONE, platform: 'facebook' })).toBe(
      '/orgs/o1/comments?platform=facebook',
    );
    const href = pageHref('o1', { ...NONE, status: 'new' }, { before: ISO, beforeId: ID });
    const q = new URLSearchParams(href.split('?')[1]);
    expect(Object.fromEntries(q)).toEqual({ status: 'new', before: ISO, beforeId: ID });
  });

  it('apiQuery adds the page size', () => {
    const q = new URLSearchParams(apiQuery({ ...NONE, ad: 'none' }, null));
    expect(Object.fromEntries(q)).toEqual({ ad: 'none', queue: 'open', limit: '50' });
  });

  it('hasFilters', () => {
    expect(hasFilters(NONE)).toBe(false);
    expect(hasFilters({ ...NONE, category: '_none' })).toBe(true);
  });
});

describe('labels', () => {
  it('adOptionLabels: deleted, unnamed, long and colliding names', () => {
    const labels = adOptionLabels([
      ad({ adId: 'a', deleted: true, name: 'Old' }),
      ad({ adId: 'b', name: null, externalId: '123' }),
      ad({ adId: 'c', name: 'x'.repeat(300), externalId: '3' }),
      ad({ adId: 'd', name: 'Summer', platforms: ['facebook', 'instagram'], brandName: 'Acme' }),
      ad({ adId: 'e', name: ' summer ', platforms: ['instagram'], brandName: 'Beta' }),
    ]);
    expect(labels.get('a')).toBe('Deleted ad');
    expect(labels.get('b')).toBe('Ad 123');
    expect(labels.get('c')).toBe(`${'x'.repeat(80)}…`);
    expect(labels.get('d')).toBe('Summer · Facebook + Instagram · Acme');
    expect(labels.get('e')).toBe('summer · Instagram · Beta');
  });

  it('rowAdLabel', () => {
    const a = (name: string) => ({ adId: name, externalId: '1', name, deleted: false });
    expect(rowAdLabel({ ads: [], adCount: 0 })).toBe('Not on an ad');
    expect(rowAdLabel({ ads: [a('One')], adCount: 1 })).toBe('One');
    expect(rowAdLabel({ ads: [a('One'), a('Two'), a('Three')], adCount: 3 })).toBe('One +2 more');
  });

  it('categoryLabel', () => {
    expect(categoryLabel(null)).toBe('Uncategorized');
    expect(categoryLabel('spam')).toBe('Spam');
    expect(categoryLabel('brand_new_cat')).toBe('Brand new cat');
  });

  it('statusLabel covers every status and falls back', () => {
    expect(COMMENT_STATUSES.map(statusLabel)).toEqual([
      'New',
      'Flagged',
      'Awaiting action',
      'Reviewed',
    ]);
    expect(statusLabel('weird')).toBe('Unknown status');
  });

  it('totalText', () => {
    expect(totalText(1)).toBe('1 comment');
    expect(totalText(2)).toBe('2 comments');
  });
});

describe('noticeText', () => {
  const acct = (problem: AccountHealthDto['problem']): AccountHealthDto => ({
    connectionId: 'c',
    brandId: 'b',
    brandName: 'Acme',
    platform: 'instagram',
    displayName: 'acme_ig',
    problem,
    lastSyncedAt: null,
  });

  it('has copy for each problem and null otherwise', () => {
    expect(noticeText(acct('reconnect_required'))).toBe(
      'Instagram account "acme_ig" (Acme) needs to be reconnected. Comments from it may be out of date.',
    );
    expect(noticeText(acct('sync_failing'))).toBe(
      'We couldn\'t sync Instagram account "acme_ig" (Acme) recently. Comments from it may be out of date.',
    );
    expect(noticeText(acct(null))).toBeNull();
    expect(noticeText({ ...acct('sync_failing'), displayName: null })).toContain(
      '"Unnamed account"',
    );
  });
});
