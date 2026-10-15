import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PreviewResult } from '../../lib/classifier';
import { PreviewPanel } from './preview-panel';

const result: PreviewResult = {
  window: { from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' },
  examined: 3,
  changed: 2,
  transitions: { 'none→hide': 1, 'hide→remove': 1 },
  samples: [],
  capped: false,
};

const render = (r: PreviewResult) => renderToStaticMarkup(<PreviewPanel result={r} />);

describe('PreviewPanel', () => {
  it('summarises the change and its transitions', () => {
    const html = render(result);
    expect(html).toContain('Would change 2 of 3 comments');
    expect(html).toContain('Not actioned → Hide: 1');
    expect(html).toContain('Hide → Delete: 1');
    expect(html).not.toContain('most recent 20,000');
  });

  it('notes when the window was capped', () => {
    expect(render({ ...result, capped: true })).toContain(
      'Showing the most recent 20,000 comments',
    );
  });
});
