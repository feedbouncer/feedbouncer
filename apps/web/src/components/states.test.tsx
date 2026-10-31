import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorPanel, LoadingPanel, TableScroll } from './states';

describe('state panels', () => {
  it('LoadingPanel is a polite busy status with skeleton rows', () => {
    const html = renderToStaticMarkup(<LoadingPanel label="Loading comments…" rows={5} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading comments…');
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(5);
    expect(html).not.toMatch(/(?<!motion-safe:)animate-pulse/);
  });

  it('LoadingPanel defaults to 3 rows', () => {
    const html = renderToStaticMarkup(<LoadingPanel label="Loading" />);
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(3);
  });

  it('ErrorPanel is an alert with a hidden icon', () => {
    const html = renderToStaticMarkup(
      <ErrorPanel title="Could not load" action={<a href="/x">Retry</a>}>
        details
      </ErrorPanel>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('details');
    expect(html).toContain('Retry');
  });

  it('TableScroll scrolls horizontally', () => {
    const html = renderToStaticMarkup(<TableScroll>x</TableScroll>);
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('data-table-scroll');
  });
});
