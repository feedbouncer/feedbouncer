import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/scan' }));

import ScanError from './error';

describe('scan error page', () => {
  it('shows generic copy and the digest, never the message', () => {
    const boom = Object.assign(new Error('db password=hunter2'), { digest: 'abc' });
    const html = renderToStaticMarkup(<ScanError error={boom} reset={() => {}} />);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('abc');
    expect(html).not.toContain('hunter2');
    expect(html).not.toContain('data-shell');
  });
});
