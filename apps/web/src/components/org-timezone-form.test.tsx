import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OrgTimezoneForm } from './org-timezone-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

describe('OrgTimezoneForm', () => {
  it('a timezone select that says when the zone is not set yet', () => {
    const unset = renderToStaticMarkup(
      <OrgTimezoneForm orgId="o" timezone="UTC" timezoneSet={false} />,
    );
    expect(unset).toContain('Workspace timezone (not set, using UTC)');
    expect(unset).toMatch(/<select name="timezone"[^>]*>/);
    const set = renderToStaticMarkup(
      <OrgTimezoneForm orgId="o" timezone="Europe/Berlin" timezoneSet />,
    );
    expect(set).toContain('<option value="Europe/Berlin" selected="">Europe/Berlin</option>');
    expect(set).not.toContain('not set');
  });
});
