import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

const render = (kind: 'no_accounts' | 'no_comments' | 'no_match', canManage = true) =>
  renderToStaticMarkup(<EmptyState kind={kind} orgId="o1" canManage={canManage} />);

describe('EmptyState', () => {
  it('uses the exact copy for each kind', () => {
    expect(render('no_comments')).toContain('No comments yet');
    expect(render('no_comments')).toContain(
      'New comments on your connected accounts will appear here.',
    );
    const none = render('no_accounts');
    expect(none).toContain('Connect an account to see comments');
    expect(none).toContain('FeedBouncer shows comments from the accounts you connect.');
    expect(render('no_match')).toContain('No comments match these filters');
  });

  it('no_match links to Clear filters', () => {
    const html = render('no_match');
    expect(html).toContain('href="/orgs/o1/comments"');
    expect(html).toContain('>Clear filters</a>');
  });

  it('no_accounts links only for managers', () => {
    expect(render('no_accounts')).toContain('<a href="/orgs/o1">Connect an account</a>');
    const member = render('no_accounts', false);
    expect(member).toContain('Ask an admin to connect an account.');
    expect(member).not.toContain('<a');
  });
});
