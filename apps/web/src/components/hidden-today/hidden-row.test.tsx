import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { COLLAPSE_AT } from '../../lib/comment-text';
import type { HiddenItemDto, HiddenRowState } from '../../lib/hidden-today';
import { HiddenRow } from './hidden-row';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const item = (over: Partial<HiddenItemDto> = {}): HiddenItemDto => ({
  hideActionId: '6f1c3a7e-1b2c-4d5e-8f90-123456789abc',
  organizationId: 'o',
  organizationName: 'Org',
  brandId: 'b',
  brandName: 'Brand',
  connectionId: 'c',
  connectionName: 'Shop Page',
  connectionStatus: 'active',
  platform: 'facebook',
  commentId: 'cm',
  commentBody: 'hello',
  commentState: 'hidden',
  authorName: 'Ann',
  hiddenAt: '2026-10-16T10:00:00.000Z',
  source: { type: 'rule', ruleId: 'r', ruleName: 'No spam' },
  reason: 'Matched a keyword.',
  lastAttempt: null,
  state: 'hidden',
  canUnhide: true,
  history: [
    {
      kind: 'hide',
      actorType: 'rule',
      actorName: null,
      status: 'applied',
      outcomeCode: null,
      at: '2026-10-16T10:00:00.000Z',
    },
  ],
  ...over,
});

const render = (i: HiddenItemDto) =>
  renderToStaticMarkup(<HiddenRow item={i} onChange={() => undefined} />);

describe('HiddenRow', () => {
  it('shows who, where, when and why', () => {
    const html = render(item());
    expect(html).toContain('Ann');
    expect(html).toContain('Facebook');
    expect(html).toContain('Shop Page');
    expect(html).toContain('Brand');
    expect(html).toContain('<time dateTime="2026-10-16T10:00:00.000Z">');
    expect(html).toContain('Rule: No spam');
    expect(html).toContain('Matched your rule &#x27;No spam&#x27;');
    expect(html).toContain('Matched a keyword.');
    expect(html).toContain('<details>');
    expect(html).toContain('History');
  });

  it('renders Unhide only for hidden and failed (canUnhide)', () => {
    const states: HiddenRowState[] = [
      'hidden',
      'pending',
      'restored',
      'already_visible',
      'unavailable',
      'failed',
    ];
    for (const state of states) {
      const html = render(item({ state, canUnhide: state === 'hidden' || state === 'failed' }));
      const has = />Unhide<\/button>/.test(html);
      expect(has, state).toBe(state === 'hidden' || state === 'failed');
    }
  });

  it('shows the state label and detail, with role=status', () => {
    const html = render(item({ state: 'already_visible', canUnhide: false }));
    expect(html).toContain('Already visible');
    expect(html).toContain('It was already visible on Facebook.');
    expect(html).toMatch(/<[a-z]+ role="status"/);
  });

  it('offers no Delete, Ban, Reply or Hide buttons in any state', () => {
    const states: HiddenRowState[] = [
      'hidden',
      'pending',
      'restored',
      'already_visible',
      'unavailable',
      'failed',
    ];
    for (const state of states) {
      const html = render(item({ state, canUnhide: true }));
      expect(html).not.toMatch(/>(Delete|Ban|Reply|Hide)[^<]*<\/button>/);
    }
  });

  it('renders hostile text escaped, with no link and dir=auto', () => {
    const body = '<script>alert(1)</script> https://evil.example שלום 👩‍👩‍👧‍👦';
    const html = render(item({ commentBody: body, authorName: '<b>x</b>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; https://evil.example שלום 👩‍👩‍👧‍👦');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toMatch(/<a [^>]*evil\.example/);
    expect(html).toContain('dir="auto"');
  });

  it('a long body shows Show more', () => {
    expect(render(item({ commentBody: 'x'.repeat(COLLAPSE_AT + 50) }))).toContain('Show more');
  });
});
