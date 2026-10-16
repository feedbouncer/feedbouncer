import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../lib/api-client';
import { decisionErrorText, type QueueFilter, type SuggestionView } from '../../lib/review-mode';
import { ConfirmApprove, SuggestionQueue } from './suggestion-queue';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const CONN = '22222222-2222-4222-8222-222222222222';
const AUTHOR = '33333333-3333-4333-8333-333333333333';

const item = (over: Partial<SuggestionView> = {}): SuggestionView => ({
  id: '11111111-1111-4111-8111-111111111111',
  connectionId: CONN,
  platform: 'facebook',
  commentId: 'cm1',
  commentBody: 'buy now',
  authorId: AUTHOR,
  authorName: 'Sam',
  authorPendingCount: 2,
  status: 'pending',
  statusReason: null,
  createdAt: '2026-10-21T10:00:00.000Z',
  decidedAt: null,
  decidedByName: null,
  expiresAt: null,
  sources: [
    {
      type: 'rule',
      ruleId: 'r1',
      ruleName: 'Spam links',
      ruleLive: true,
      alsoMatched: [{ ruleId: 'r2', ruleName: 'Shouting' }],
      steps: [{ type: 'delete', confirmIrreversible: true }],
      reason: 'link to a blocked domain',
      createdAt: '2026-10-21T10:00:00.000Z',
    },
    {
      type: 'classifier',
      ruleId: null,
      ruleName: null,
      ruleLive: false,
      alsoMatched: [],
      steps: [{ type: 'hide' }],
      reason: 'spam 0.97',
      createdAt: '2026-10-21T10:01:00.000Z',
    },
    {
      type: 'policy',
      ruleId: null,
      ruleName: null,
      ruleLive: false,
      alsoMatched: [],
      steps: [{ type: 'hide' }],
      reason: 'off-topic sales',
      createdAt: '2026-10-21T10:02:00.000Z',
    },
  ],
  plan: {
    steps: [{ type: 'delete', confirmIrreversible: true }],
    dropped: [{ type: 'hide', reason: 'hide_redundant_with_delete' }],
  },
  execution: null,
  ...over,
});

const render = (items: SuggestionView[], filter: QueueFilter = { status: 'pending' }) =>
  renderToStaticMarkup(
    <SuggestionQueue
      orgId="o"
      brandId="b"
      items={items}
      next={null}
      authors={[{ authorId: AUTHOR, authorName: 'Sam', pendingCount: 2 }]}
      filter={filter}
      connections={[{ id: CONN, name: 'Shop Page' }]}
      rules={[{ id: 'r1', name: 'Spam links' }]}
    />,
  );

describe('SuggestionQueue', () => {
  it('shows a row with its sources, plan, dropped steps and status', () => {
    const html = render([item()]);
    expect(html).toContain('buy now');
    expect(html).toContain('Rule: Spam links');
    expect(html).toContain('link to a blocked domain');
    expect(html).toContain('Also matched: Shouting');
    expect(html).toContain('AI classifier');
    expect(html).toContain('Custom policy');
    expect(html).toContain('Delete');
    expect(html).toContain('Hide left out: Delete already removes the comment.');
    expect(html).toContain('Waiting for review.');
    expect(html).toContain('>Approve</button>');
    expect(html).toContain('>Dismiss</button>');
  });

  it('links the author count to the author filter', () => {
    const html = render([item()]);
    expect(html).toContain(
      `href="/orgs/o/brands/b/suggestions?connectionId=${CONN}&amp;authorId=${AUTHOR}">2 pending from this author</a>`,
    );
  });

  it('renders comment text, author and reasons as text only', () => {
    const html = render([
      item({
        commentBody: '<script>alert(1)</script>',
        authorName: '<b>Eve</b>',
        sources: [{ ...item().sources[0]!, reason: '<i>r</i>', ruleName: '<u>n</u>' }],
      }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Eve</b>');
    expect(html).not.toContain('<i>r</i>');
    expect(html).not.toContain('<u>n</u>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('offers selection and bulk actions', () => {
    const html = render([item()]);
    expect(html).toContain('Select all on this page');
    expect(html).toContain('>Approve selected</button>');
    expect(html).toContain('>Dismiss selected</button>');
    expect(html).not.toContain('all from this author');
  });

  it('offers author bulk actions when filtered to one author', () => {
    const html = render([item()], { status: 'pending', connectionId: CONN, authorId: AUTHOR });
    expect(html).toContain('>Approve all from this author</button>');
    expect(html).toContain('>Dismiss all from this author</button>');
  });

  it('has filters for connection, rule, proposed action, status and author', () => {
    const html = render([item()], { status: 'pending', connectionId: CONN });
    for (const name of ['connectionId', 'ruleId', 'stepType', 'status', 'authorId']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('Shop Page');
  });

  it('shows the empty-state copy', () => {
    expect(render([])).toContain(
      'No suggestions waiting. During review mode, when a rule, the classifier or a policy matches a comment, the action it would take appears here for you to approve or dismiss.',
    );
  });

  it('shows already-handled message on 409', () => {
    const err = new ApiRequestError(409, 'suggestion_already_handled', 'x', undefined, [], {
      status: 'approved',
      decidedAt: '2026-10-22T09:00:00.000Z',
      decidedByName: 'Ana',
    });
    expect(decisionErrorText(err, (iso) => `<${iso}>`)).toEqual({
      handled: true,
      text: 'Already handled by Ana at <2026-10-22T09:00:00.000Z>.',
    });
    expect(
      decisionErrorText(new ApiRequestError(409, 'connection_inactive', 'x'), (i) => i),
    ).toEqual({
      handled: false,
      text: 'This connection is not active. Reconnect it and try again.',
    });
  });
});

describe('ConfirmApprove', () => {
  it('asks before running a delete or ban', () => {
    const html = renderToStaticMarkup(
      <ConfirmApprove
        title="Approve this suggestion?"
        busy={false}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('This runs every suggested action, including deletes and bans.');
    expect(html).toContain('>Approve and run</button>');
    expect(html).toContain('>Cancel</button>');
  });
});
