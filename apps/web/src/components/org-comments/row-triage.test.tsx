import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RowTriage } from './row-triage';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const TAGS = [
  { id: 't1', name: 'Urgent' },
  { id: 't2', name: 'Later' },
];
const ALLOWED = { reply: true, triage: true, manageTags: false };

const render = (
  done: { at: string; byName: string | null } | null,
  permissions = ALLOWED,
  applied = [TAGS[0]!],
) =>
  renderToStaticMarkup(
    <RowTriage
      orgId="o1"
      comment={{ id: 'c1', done, tags: applied }}
      tags={TAGS}
      permissions={permissions}
    />,
  );

describe('RowTriage', () => {
  it('offers Mark done on an open comment and Reopen on a done one', () => {
    const open = render(null);
    expect(open).toContain('>Mark done</button>');
    expect(open).not.toContain('Reopen');
    const done = render({ at: '2026-10-27T11:00:00.000Z', byName: 'Noa' });
    expect(done).toContain('>Reopen</button>');
    expect(done).not.toContain('Mark done');
  });

  it('includes the tag picker for the row', () => {
    const html = render(null);
    expect(html).toContain('aria-label="Remove tag Urgent"');
    expect(html).toMatch(/<option value="t2"[^>]*>Later<\/option>/);
  });

  it('renders nothing without the triage permission', () => {
    expect(render(null, { ...ALLOWED, triage: false })).toBe('');
  });
});
