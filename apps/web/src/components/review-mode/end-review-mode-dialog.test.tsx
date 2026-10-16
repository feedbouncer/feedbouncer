import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { endReviewModeBody } from '../../lib/review-mode';
import { EndReviewModeDialog } from './end-review-mode-dialog';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const html = renderToStaticMarkup(
  <EndReviewModeDialog orgId="o" brandId="b" connectionId="c1" onClose={() => undefined} />,
);

/** The opening tag of the input labelled by `label`. */
function inputFor(label: string): string {
  const at = html.indexOf(label);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<input', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

describe('EndReviewModeDialog', () => {
  it('offers the three options with the exact copy, leaving them waiting by default', () => {
    expect(html).toContain('role="dialog"');
    const leave = inputFor('Leave them waiting (they expire 72 hours after review mode ends)');
    expect(leave).toContain('type="radio"');
    expect(leave).toContain('checked=""');
    expect(inputFor('Dismiss all')).toContain('type="radio"');
    expect(
      inputFor('Approve all (runs every suggested action, including deletes and bans)'),
    ).toContain('type="radio"');
  });

  it('requires confirm for approve-all', () => {
    const box = inputFor('I understand this runs every suggested action now.');
    expect(box).toContain('type="checkbox"');
    expect(box).toContain('disabled=""');
    expect(endReviewModeBody('approve', false)).toBeNull();
    expect(endReviewModeBody('approve', true)).toEqual({ pending: 'approve', confirm: true });
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled)[^>]*>End review mode</);
  });
});
