import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { browserTimezone } from '../lib/timezone';

const seen: Array<Record<string, unknown>> = [];
vi.mock('./api-form', () => ({
  ApiForm: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

import { CreateBrandForm } from './create-brand-form';

describe('CreateBrandForm', () => {
  it('posts the brand name to the org brands route with the browser timezone', () => {
    renderToStaticMarkup(<CreateBrandForm orgId="o1" />);
    const props = seen[0]!;
    expect(props.action).toBe('/api/v1/orgs/o1/brands');
    expect(props.submitLabel).toBe('Create brand');
    expect(props.fields).toEqual([{ name: 'name', label: 'Brand name', type: 'text' }]);
    // Resolved when the form is submitted, so it is the browser's zone, not the server's render.
    const extra = props.extraBody as () => Record<string, unknown>;
    expect(extra()).toEqual({ timezone: browserTimezone() });
    expect(browserTimezone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
