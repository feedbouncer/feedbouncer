import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VisibleCommentDto } from '../../lib/org-comments';
import { CommentList } from './comment-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const item = (id: string, o: Partial<VisibleCommentDto> = {}): VisibleCommentDto => ({
  id,
  brandId: 'b1',
  brandName: 'Acme',
  connectionId: 'cn1',
  connectionName: 'Acme Page',
  platform: 'facebook',
  authorName: 'Dana',
  body: `Body ${id}`,
  postedAt: '2026-10-27T10:04:05.000Z',
  permalink: null,
  isReply: false,
  parentRemoved: false,
  ads: [],
  adCount: 0,
  category: null,
  status: 'new',
  stale: false,
  done: null,
  tags: [],
  replies: [],
  replyCount: 0,
  reply: { available: true, maxChars: 8000 },
  ...o,
});

const ALL = { reply: true, triage: true, manageTags: true };

const render = (permissions = ALL) =>
  renderToStaticMarkup(
    <CommentList
      orgId="o1"
      items={[item('c1'), item('c2', { reply: { available: false, reason: 'not_permitted' } })]}
      tags={[{ id: 't1', name: 'Urgent' }]}
      permissions={permissions}
      canManageConnections={false}
    />,
  );

describe('CommentList', () => {
  it('renders a checkbox per row, Select all, triage and a composer on each row', () => {
    const html = render();
    expect(html).toContain('Select all on this page');
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Select comment by Dana"');
    expect(html.match(/>Mark done<\/button>/g)).toHaveLength(2);
    expect(html.match(/>Send reply<\/button>/g)).toHaveLength(2);
    expect(html).toContain('Body c1');
    expect(html).toContain('Body c2');
    // Nothing is selected yet, so there is no bulk bar.
    expect(html).not.toContain('selected</');
  });

  it('without triage: no checkboxes, no triage, read-only rows', () => {
    const html = render({ ...ALL, triage: false });
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Select all on this page');
    expect(html).not.toContain('Mark done');
    expect(html.match(/>Send reply<\/button>/g)).toHaveLength(2);
  });
});
