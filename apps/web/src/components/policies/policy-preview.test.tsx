import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PreviewView } from '../../lib/policies';
import { PolicyPreview } from './policy-preview';

const view: PreviewView = {
  id: 'v1',
  status: 'done',
  text: 'Hide comments asking readers to message another account',
  action: 'hide',
  days: 7,
  since: '2026-10-08T00:00:00.000Z',
  total: 2,
  capped: false,
  examined: 2,
  matched: 1,
  errors: 0,
  notChecked: 0,
  stoppedReason: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  completedAt: '2026-10-15T10:01:00.000Z',
  results: [
    {
      commentId: 'c1',
      verdict: 'clear_match',
      proposedAction: 'hide',
      reason: 'Clear match: would hide.',
      errorCode: null,
      excerpt: 'DM me for a free gift',
      platform: 'facebook',
    },
    {
      commentId: 'c2',
      verdict: 'no_match',
      proposedAction: null,
      reason: null,
      errorCode: null,
      excerpt: 'Great post',
      platform: 'facebook',
    },
  ],
};

describe('PolicyPreview', () => {
  it('summarises the run and lists a row per match', () => {
    const html = renderToStaticMarkup(<PolicyPreview view={view} />);
    expect(html).toContain('Would act on 1 of 2 comments from the last 7 days.');
    expect(html).toContain('DM me for a free gift');
    expect(html).toContain('Hide');
    expect(html).toContain('Clear match: would hide.');
    expect(html).not.toContain('Great post');
    expect(html).toContain('Dry run — nothing was hidden, deleted or logged.');
  });

  it('renders excerpts as inert text', () => {
    const html = renderToStaticMarkup(
      <PolicyPreview
        view={{
          ...view,
          results: [{ ...view.results[0]!, excerpt: '<img src=x onerror=alert(1)>' }],
        }}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
