import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RevisionHistory } from './revision-history';

describe('RevisionHistory', () => {
  it('lists revisions newest first with text, action and date', () => {
    const html = renderToStaticMarkup(
      <RevisionHistory
        revisions={[
          {
            id: 'r2',
            revision: 2,
            text: 'Hide comments asking readers to message another account',
            action: 'hide',
            createdAt: '2026-10-15T10:00:00.000Z',
            createdBy: { id: 'u1', name: 'Omri' },
          },
          {
            id: 'r1',
            revision: 1,
            text: 'Flag comments telling people to DM another account',
            action: 'flag',
            createdAt: '2026-10-14T09:30:00.000Z',
            createdBy: null,
          },
        ]}
      />,
    );
    expect(html.indexOf('Revision 2')).toBeLessThan(html.indexOf('Revision 1'));
    expect(html).toContain('Hide · 2026-10-15 10:00 UTC · Omri');
    expect(html).toContain('Flag for review · 2026-10-14 09:30 UTC');
    expect(html).toContain('Flag comments telling people to DM another account');
  });
});
