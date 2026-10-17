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
} from './org-comments';

const ID = '3f9a1c52-8d1e-4b6a-9c3f-2a7b5e4d1c60';
const NONE = { platform: null, ad: null, category: null, status: null };
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
    ).toEqual({ platform: 'instagram', ad: 'none', category: '_none', status: 'new' });
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
    expect(Object.fromEntries(q)).toEqual({ ad: 'none', limit: '50' });
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
