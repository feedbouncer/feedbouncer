import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntryView } from '../lib/actions';
import { CommentHistory, HistoryRows } from './comment-history';

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

const rows = (entries: LogEntryView[], onUndo = () => undefined) =>
  HistoryRows({ entries, platform: 'threads', busy: false, onUndo });

const html = (entries: LogEntryView[]) => renderToStaticMarkup(rows(entries));

function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === 'button' ? [node as ReactElement<{ onClick?: () => void }>] : [];
  return [...own, ...buttons(node.props.children)];
}

describe('HistoryRows', () => {
  it('shows rule, action, result and time for each step', () => {
    const out = html([
      entry({ id: 'a', ruleName: 'Spam' }),
      entry({
        id: 'b',
        ruleName: null,
        type: 'auto_reply',
        status: 'failed',
        reasonCode: 'threads_error_100',
        createdAt: '2026-10-17T11:30:00.000Z',
      }),
    ]);
    expect(out).toContain('Spam');
    expect(out).toContain('Hide');
    expect(out).toContain('Done');
    expect(out).toContain('2026-10-16 10:00 UTC');
    expect(out).toContain('Manual');
    expect(out).toContain('Auto-reply');
    expect(out).toContain('Failed: Threads refused this action (code 100).');
    expect(out).toContain('2026-10-17 11:30 UTC');
  });

  it('shows Delayed until for a deferred reply', () => {
    const out = html([
      entry({
        type: 'auto_reply',
        status: 'pending',
        deferredUntil: '2026-10-18T08:15:00.000Z',
        deferredCode: 'reply_quota_exhausted',
      }),
    ]);
    expect(out).toContain('Delayed until 2026-10-18 08:15 UTC');
    expect(out).toContain('Threads&#x27; daily limit of 1,000 replies is reached');
    // The deferral reason must not repeat its own "Delayed" prefix.
    expect(out.match(/Delayed/g)).toHaveLength(1);
  });

  it('shows a generic deferral reason for a throttled hide, on any platform', () => {
    const out = html([
      entry({
        type: 'hide',
        status: 'pending',
        deferredUntil: '2026-10-18T08:15:00.000Z',
        deferredCode: 'throttled',
      }),
    ]);
    expect(out).toContain('Delayed until 2026-10-18 08:15 UTC');
    expect(out).not.toContain('it could not be completed');
  });

  it('says there is no history yet for an empty list', () => {
    expect(html([])).toContain('No actions yet.');
  });

  it('Undo calls the undo endpoint for a hide step and is absent for a reply step', () => {
    const onUndo = vi.fn();
    const tree = rows(
      [
        entry({ id: 'hide-1', type: 'hide', undoable: true }),
        entry({ id: 'reply-1', type: 'auto_reply', undoable: false }),
        entry({ id: 'reply-2', type: 'auto_reply', undoable: true }),
        entry({ id: 'hide-2', type: 'hide', status: 'failed', undoable: true }),
      ],
      onUndo,
    );
    const undo = buttons(tree);
    expect(undo).toHaveLength(1);
    undo[0]!.props.onClick?.();
    expect(onUndo).toHaveBeenCalledWith('hide-1');
  });

  it('renders reply text containing <img onerror> as text', () => {
    const out = html([
      entry({
        type: 'auto_reply',
        previewText: '<img src=x onerror=alert(1)>',
        ruleName: '<b>rule</b>',
        reasonCode: '<script>',
      }),
    ]);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('CommentHistory', () => {
  it('starts closed with a History button', () => {
    const out = renderToStaticMarkup(
      <CommentHistory orgId="o" brandId="b" commentId="c1" platform="threads" />,
    );
    expect(out).toContain('>History</button>');
    expect(out).not.toContain('No actions yet.');
  });
});
