import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WeekPicker } from './WeekPicker';

describe('WeekPicker', () => {
  it('a GET form listing the shown week and the report weeks, newest first', () => {
    const html = renderToStaticMarkup(
      <WeekPicker
        orgId="o1"
        current="2026-10-05"
        weeks={['2026-09-28', '2026-10-05', '2026-09-14']}
      />,
    );
    expect(html).toMatch(/<form action="\/orgs\/o1\/reports"( method="get")?>/);
    expect([...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '2026-10-05',
      '2026-09-28',
      '2026-09-14',
    ]);
    expect(html).toContain('<option value="2026-10-05" selected="">Week of Oct 5, 2026</option>');
    expect(html).toContain('name="week"');
  });
});
