import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  adOptionLabels,
  type FilterOptionsDto,
  type OrgCommentFilters,
} from '../../lib/org-comments';
import { FilterBar } from './filter-bar';

const options: FilterOptionsDto = {
  platforms: ['facebook', 'instagram'],
  ads: [
    {
      adId: 'ad1',
      externalId: '1',
      name: 'Spring',
      deleted: false,
      adAccountExternalId: 'act_1',
      brandName: 'Acme',
      platforms: ['facebook'],
    },
  ],
  adsTruncated: false,
  categories: ['spam', 'new_one'],
  statuses: ['new', 'flagged', 'awaiting_action', 'reviewed'],
  tags: [
    { id: 't1', name: 'Urgent' },
    { id: 't2', name: '<b>VIP</b>' },
  ],
};
const none: OrgCommentFilters = {
  platform: null,
  ad: null,
  category: null,
  status: null,
  queue: 'open',
  tags: [],
};

const render = (o = options, applied = none) =>
  renderToStaticMarkup(
    <FilterBar orgId="o1" options={o} applied={applied} labels={adOptionLabels(o.ads)} />,
  );

describe('FilterBar', () => {
  it('has labelled selects with All first and the special options', () => {
    const html = render();
    for (const l of ['Platform', 'Ad', 'Category', 'Status']) expect(html).toContain(`>${l}`);
    expect(html).toContain('action="/orgs/o1/comments"');
    expect(html).toContain('method="get"');
    expect(html.match(/<select[^>]*>\s*<option value="" selected="">All<\/option>/g)).toHaveLength(
      4,
    );
    expect(html).toContain('>Not on an ad</option>');
    expect(html).toContain('>Uncategorized</option>');
    expect(html).toContain('>Spring</option>');
    expect(html).toContain('>New one</option>');
    expect(html).toContain('>Awaiting action</option>');
    expect(html).toContain('>Apply</button>');
  });

  it('selects applied values', () => {
    const html = render(options, {
      platform: 'instagram',
      ad: 'none',
      category: 'spam',
      status: 'new',
      queue: 'open',
      tags: [],
    });
    for (const v of ['instagram', 'none', 'spam', 'new'])
      expect(html).toContain(`<option value="${v}" selected="">`);
  });

  it('Show defaults to Open; Tags multi-select marks applied; Manage tags link', () => {
    const html = render();
    expect(html).toContain('>Show');
    expect(html).toMatch(
      /<select name="queue">\s*<option value="open" selected="">Open<\/option><option value="done">Done<\/option><option value="all">All<\/option><\/select>/,
    );
    expect(render(options, { ...none, queue: 'done' })).toContain(
      '<option value="done" selected="">Done</option>',
    );
    expect(html).toContain('>Tags');
    expect(html).toMatch(/<select[^>]*name="tag"[^>]*multiple=""/);
    expect(html).toContain('Comments must have every selected tag.');
    expect(html).toContain('&lt;b&gt;VIP&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    const applied = render(options, { ...none, tags: ['t2'] });
    expect(applied).toContain('<option value="t2" selected="">');
    expect(applied).toContain('<option value="t1">Urgent</option>');
    expect(applied).toContain('Clear filters');
    expect(html).toContain('<a href="/orgs/o1/tags">Manage tags</a>');
    // With no tags in the workspace there is nothing to pick, but tags can still be managed.
    const empty = render({ ...options, tags: [] });
    expect(empty).not.toContain('name="tag"');
    expect(empty).toContain('Manage tags');
  });

  it('never carries a cursor', () => {
    expect(render()).not.toMatch(/name="before/);
  });

  it('shows Clear filters only when filters are applied', () => {
    expect(render()).not.toContain('Clear filters');
    const html = render(options, { ...none, status: 'new' });
    expect(html).toContain('href="/orgs/o1/comments"');
    expect(html).toContain('Clear filters');
  });

  it('escapes option text', () => {
    const o = { ...options, ads: [{ ...options.ads[0]!, name: '</option><script>x</script>' }] };
    const html = render(o);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;/option&gt;&lt;script&gt;');
  });

  it('notes truncated ad options', () => {
    expect(render()).not.toContain('Showing the first 500 ads.');
    expect(render({ ...options, adsTruncated: true })).toContain('Showing the first 500 ads.');
  });
});
