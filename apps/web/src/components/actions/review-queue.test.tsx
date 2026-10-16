import type { ReviewItemView } from '../../lib/actions';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmResolve, ReviewQueue } from './review-queue';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const item = (over: Partial<ReviewItemView> = {}): ReviewItemView => ({
  id: 'i1',
  commentId: 'c1',
  source: 'action_step',
  ruleName: 'Spam',
  commentBody: 'buy now',
  authorName: 'Sam',
  ...over,
});

const render = (items: ReviewItemView[]) =>
  renderToStaticMarkup(<ReviewQueue orgId="o" brandId="b" items={items} next={null} />);

describe('ReviewQueue', () => {
  it('offers Approve, Hide, Delete and Ban per open item', () => {
    const html = render([item()]);
    for (const label of ['Approve', 'Hide', 'Delete', 'Ban author']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('Rule: Spam');
  });

  it('renders comment text and author as text only', () => {
    const html = render([
      item({ commentBody: '<script>alert(1)</script>', authorName: '<b>Eve</b>' }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Eve</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('hides Ban when the brand cannot ban', () => {
    const html = renderToStaticMarkup(
      <ReviewQueue orgId="o" brandId="b" items={[item()]} next={null} canBan={false} />,
    );
    expect(html).not.toContain('>Ban author<');
    expect(html).toContain('>Delete<');
  });

  it('encodes the next-page cursor', () => {
    const html = renderToStaticMarkup(
      <ReviewQueue orgId="o" brandId="b" items={[item()]} next="a&b" />,
    );
    expect(html).toContain('before=a%26b');
  });

  it('says when the queue is empty', () => {
    expect(render([])).toContain('Nothing to review.');
  });

  it('does not open a confirm dialog before Delete or Ban is chosen', () => {
    expect(render([item()])).not.toContain('role="dialog"');
  });
});

describe('ConfirmResolve', () => {
  const dialog = { itemId: 'i1', resolution: 'delete', requestKey: 'k' } as const;

  it('asks before an irreversible delete', () => {
    const html = renderToStaticMarkup(
      <ConfirmResolve
        dialog={dialog}
        busy={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Irreversible');
    expect(html).toContain('>Delete comment<');
    expect(html).toContain('>Cancel<');
  });

  it('disables the confirm button while the request is in flight', () => {
    const html = renderToStaticMarkup(
      <ConfirmResolve
        dialog={{ ...dialog, resolution: 'ban' }}
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('Hard to reverse (unban)');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ban author</);
  });
});
