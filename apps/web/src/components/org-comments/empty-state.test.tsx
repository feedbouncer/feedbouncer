import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

const render = (kind: Parameters<typeof EmptyState>[0]['kind'], canManage = true) =>
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

  it('no_open copy with Show done comments link; no_done copy', () => {
    const open = render('no_open');
    expect(open).toContain('<h2>No open comments</h2>');
    expect(open).toContain('<a href="/orgs/o1/comments?queue=done">Show done comments</a>');
    const done = render('no_done');
    expect(done).toContain('<h2>No done comments</h2>');
    expect(done).not.toContain('Show done comments');
  });
});
