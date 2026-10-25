import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntryView } from '../../lib/actions';
import { ActionLog } from './action-log';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const entry = (over: Partial<LogEntryView>): LogEntryView => ({
  id: 's1',
  commentId: 'c1',
  ruleName: 'Spam',
  type: 'hide',
  status: 'succeeded',
  reasonCode: null,
  previewText: null,
  deferredUntil: null,
  deferredCode: null,
  undoable: false,
  undoneAt: null,
  undoStatus: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  ...over,
});

const render = (entries: LogEntryView[]) =>
  renderToStaticMarkup(
    <ActionLog
      orgId="o"
      brandId="b"
      entries={entries}
      rules={[{ id: 'r1', name: 'Spam' }]}
      filters={{}}
      next={null}
    />,
  );

describe('ActionLog', () => {
  it('shows Undo only for undoable rows', () => {
    const html = render([
      entry({ id: 'a', undoable: true }),
      entry({ id: 'b', type: 'delete', undoable: false }),
    ]);
    expect(html.match(/>Undo</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Undo Hide"');
  });

  it('shows an undo in progress, a finished one, and a failed one with a retry', () => {
    const html = render([
      entry({ id: 'a', undoneAt: '2026-10-16T10:01:00.000Z', undoStatus: 'pending' }),
      entry({ id: 'b', undoneAt: '2026-10-16T10:01:00.000Z', undoStatus: 'applied' }),
      entry({
        id: 'c',
        undoneAt: '2026-10-16T10:01:00.000Z',
        undoStatus: 'failed',
        undoable: true,
      }),
    ]);
    expect(html).toContain('Undo in progress');
    expect(html).toContain('Undone');
    expect(html).toContain('Undo failed. Try again.');
    expect(html.match(/>Retry undo</g)).toHaveLength(1);
  });

  it('shows the step, outcome and reason as text', () => {
    const html = render([
      entry({ status: 'skipped', reasonCode: 'already_hidden' }),
      entry({ id: 'x', type: 'ban', status: 'failed', reasonCode: '<b>x</b>' }),
    ]);
    expect(html).toContain('Skipped: already hidden');
    expect(html).toContain('Ban author');
    expect(html).not.toContain('<b>x</b>');
  });

  it('links to the comment and offers filters by rule, status and step', () => {
    const html = render([entry({})]);
    expect(html).toContain('/orgs/o/brands/b/comments#comment-c1');
    expect(html).toMatch(/<select[^>]*name="ruleId"/);
    expect(html).toMatch(/<select[^>]*name="status"/);
    expect(html).toMatch(/<select[^>]*name="type"/);
  });

  it('says when there is nothing yet', () => {
    expect(render([])).toContain('No actions yet.');
  });
});
