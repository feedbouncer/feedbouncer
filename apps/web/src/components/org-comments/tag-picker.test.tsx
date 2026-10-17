import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TagPicker } from './tag-picker';

const ALL = [
  { id: 't1', name: 'Urgent' },
  { id: 't2', name: '<b>VIP</b>' },
  { id: 't3', name: 'مهم' },
];

const render = (applied = [ALL[0]!], busy = false) =>
  renderToStaticMarkup(
    <TagPicker
      tags={ALL}
      applied={applied}
      busy={busy}
      onAdd={() => undefined}
      onRemove={() => undefined}
      onCreate={() => undefined}
    />,
  );

describe('TagPicker', () => {
  it('lists applied tags with remove buttons and offers the others to add', () => {
    const html = render([ALL[0]!, ALL[1]!]);
    expect(html).toContain('Tags');
    expect(html).toContain('aria-label="Remove tag Urgent"');
    expect(html).toContain('aria-label="Remove tag &lt;b&gt;VIP&lt;/b&gt;"');
    expect(html).not.toContain('<b>');
    // Applied tags are not offered again.
    expect(html).not.toContain('<option value="t1">');
    expect(html).toMatch(/<option value="t3"[^>]*>مهم<\/option>/);
    expect(html).toContain('>Add tag</button>');
    expect(html).toContain('New tag');
    expect(html).toContain('>Create</button>');
  });

  it('disables every control while busy', () => {
    const html = render([ALL[0]!], true);
    expect(html.match(/<button[^>]*>/g)!.every((b) => b.includes('disabled'))).toBe(true);
  });
});
