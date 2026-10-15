import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CATEGORIES, type ThresholdView } from '../../lib/classifier';
import { ThresholdTable } from './threshold-table';

const defaults: ThresholdView[] = CATEGORIES.map((category) => ({
  category,
  threshold: 0.8,
  action: 'hide',
  source: 'default',
  updatedAt: null,
  updatedBy: null,
}));

const render = (categories: ThresholdView[], canEdit: boolean) =>
  renderToStaticMarkup(
    <ThresholdTable categories={categories} canEdit={canEdit} onSave={vi.fn()} />,
  );

describe('ThresholdTable', () => {
  it('renders seven categories with threshold inputs and action selects, marking defaults', () => {
    const html = render(defaults, true);
    expect(html.match(/type="number"/g)).toHaveLength(7);
    expect(html.match(/<select/g)).toHaveLength(7);
    expect(html).toContain('aria-label="Spam threshold"');
    expect(html).toContain('Hate speech');
    expect(html).toContain('Default');
    expect(html).toContain('Save thresholds');
  });

  it('is read-only without edit rights', () => {
    const html = render(defaults, false);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Save thresholds');
    expect(html).toContain('0.80');
    expect(html).toContain('Hide');
  });

  it('warns that Delete cannot be undone', () => {
    const withDelete = defaults.map((d, i) => (i === 0 ? { ...d, action: 'remove' as const } : d));
    expect(render(withDelete, true)).toContain('Delete cannot be undone');
    expect(render(defaults, true)).not.toContain('Delete cannot be undone');
  });

  it('shows who changed a category and when', () => {
    const changed = defaults.map((d, i) =>
      i === 0
        ? {
            ...d,
            source: 'brand' as const,
            updatedAt: '2026-10-15T10:00:00.000Z',
            updatedBy: { id: 'u', name: 'Dana' },
          }
        : d,
    );
    const html = render(changed, true);
    expect(html).toContain('Dana');
    expect(html).toContain('2026-10-15 10:00 UTC');
    expect(html).toContain('Use default');
  });
});
