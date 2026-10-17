import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BulkBar } from './bulk-bar';

const TAGS = [
  { id: 't1', name: 'Urgent' },
  { id: 't2', name: '<i>VIP</i>' },
];

const render = (count: number, tags = TAGS, busy = false) =>
  renderToStaticMarkup(<BulkBar count={count} tags={tags} busy={busy} onRun={() => undefined} />);

describe('BulkBar', () => {
  it('hidden with no selection; shows count and buttons; Add tag lists tags', () => {
    expect(render(0)).toBe('');
    const html = render(3);
    expect(html).toContain('3 selected');
    for (const b of ['Mark done', 'Reopen', 'Add tag', 'Remove tag'])
      expect(html).toContain(`>${b}</button>`);
    expect(html).toMatch(/<option value="t1"[^>]*>Urgent<\/option>/);
    expect(html).toContain('&lt;i&gt;VIP&lt;/i&gt;');
    expect(html).not.toContain('<i>');
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it('disables the tag buttons when the workspace has no tags, and everything while busy', () => {
    const none = render(1, []);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Add tag<\/button>/);
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Remove tag<\/button>/);
    expect(none).not.toMatch(/<button[^>]*disabled=""[^>]*>Mark done<\/button>/);
    expect(render(1, TAGS, true).match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  });
});
