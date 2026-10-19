import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RuleView } from '../../lib/rules';
import { RuleList } from './rule-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const rule = (over: Partial<RuleView>): RuleView => ({
  id: 'r1',
  name: 'Rule',
  kind: 'keyword',
  conditions: { type: 'keyword', terms: ['x'], match: 'whole_word' },
  action: 'hide',
  actions: [{ type: 'hide' }],
  mode: 'enforce',
  enabled: true,
  position: 1,
  warnings: { shadowedBy: null, neverMatches: false, invalid: false },
  ...over,
});

const render = (rules: RuleView[], pendingChanges = 0) =>
  renderToStaticMarkup(
    <RuleList orgId="o" brandId="b" rules={rules} pendingChanges={pendingChanges} />,
  );

describe('RuleList', () => {
  it('lists rules in the given order with action labels', () => {
    const html = render([
      rule({ id: 'a', name: 'First', position: 1 }),
      rule({
        id: 'b',
        name: 'Second',
        action: 'remove',
        actions: [{ type: 'flag_for_review' }, { type: 'delete', confirmIrreversible: true }],
        mode: 'suggest',
        position: 2,
      }),
    ]);
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'));
    expect(html).toContain('Hide');
    expect(html).toContain('Flag for review, Delete');
    expect(html).toContain('Dry run');
    expect(html).toContain('Active');
  });

  it('names the shadowing rule in the warning', () => {
    const html = render([
      rule({
        id: 'b',
        name: 'Second',
        warnings: {
          shadowedBy: { id: 'a', name: 'Catch all' },
          neverMatches: false,
          invalid: false,
        },
      }),
    ]);
    expect(html).toContain('Never fires: &#x27;Catch all&#x27; above always matches first');
  });

  it('shows the other warnings', () => {
    const html = render([
      rule({ warnings: { shadowedBy: null, neverMatches: true, invalid: false } }),
      rule({ id: 'x', warnings: { shadowedBy: null, neverMatches: false, invalid: true } }),
    ]);
    expect(html).toContain('Never matches: the list is empty');
    expect(html).toContain('old format and is skipped');
  });

  it('has no move up on the first row and no move down on the last', () => {
    const html = render([rule({ id: 'a', name: 'A' }), rule({ id: 'b', name: 'B' })]);
    expect(html.match(/aria-label="Move A up"/g)).toBeNull();
    expect(html).toContain('aria-label="Move A down"');
    expect(html).toContain('aria-label="Move B up"');
    expect(html.match(/aria-label="Move B down"/g)).toBeNull();
  });

  it('escapes rule names', () => {
    const html = render([rule({ name: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('notes that trusted-author rules are checked first', () => {
    const html = render([
      rule({
        kind: 'author',
        conditions: { type: 'author', list: 'trusted' },
        action: 'approve',
        actions: [],
      }),
    ]);
    expect(html).toContain('Always checked first');
  });

  it('links to pending rule changes only when there are some', () => {
    expect(render([rule({})])).not.toContain('pending change');
    const html = render([rule({})], 2);
    expect(html).toContain('2 pending changes');
    expect(html).toContain('href="/orgs/o/brands/b/rules/changes"');
    expect(render([rule({})], 1)).toContain('1 pending change<');
  });

  it('still links to pending changes when there are no rules', () => {
    expect(render([], 1)).toContain('1 pending change');
  });
});
