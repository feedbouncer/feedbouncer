import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RuleView } from '../../lib/rules';
import { RuleEditor } from './rule-editor';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const existing = (over: Partial<RuleView>): RuleView => ({
  id: 'r1',
  name: 'Existing',
  kind: 'keyword',
  conditions: { type: 'keyword', terms: ['x'], match: 'whole_word' },
  action: 'hide',
  mode: 'enforce',
  enabled: true,
  position: 1,
  warnings: { shadowedBy: null, neverMatches: false, invalid: false },
  ...over,
});

/** The <select name="action"> element, with its options. */
const actionSelect = (html: string) => /<select[^>]*name="action"[\s\S]*?<\/select>/.exec(html)![0];

describe('RuleEditor', () => {
  it('starts a new rule as a dry run', () => {
    const html = renderToStaticMarkup(<RuleEditor orgId="o" brandId="b" />);
    expect(html).toMatch(/<input[^>]*name="dryRun"[^>]*checked=""/);
  });

  it('shows an enforced rule as not a dry run', () => {
    const html = renderToStaticMarkup(<RuleEditor orgId="o" brandId="b" rule={existing({})} />);
    expect(html).not.toMatch(/<input[^>]*name="dryRun"[^>]*checked/);
  });

  it('offers only Allow for an allow list', () => {
    const html = renderToStaticMarkup(
      <RuleEditor
        orgId="o"
        brandId="b"
        rule={existing({
          kind: 'author',
          action: 'approve',
          conditions: { type: 'author', list: 'allow', platform: 'facebook', entries: [] },
        })}
      />,
    );
    const select = actionSelect(html);
    expect(select).toContain('>Allow<');
    expect(select).not.toContain('>Hide<');
    expect(select).not.toContain('>Delete<');
  });

  it('offers no Allow for a block list', () => {
    const html = renderToStaticMarkup(
      <RuleEditor
        orgId="o"
        brandId="b"
        rule={existing({
          kind: 'author',
          conditions: { type: 'author', list: 'block', platform: 'facebook', entries: [] },
        })}
      />,
    );
    expect(actionSelect(html)).not.toContain('>Allow<');
  });

  it('warns that deleting cannot be undone', () => {
    const html = renderToStaticMarkup(
      <RuleEditor orgId="o" brandId="b" rule={existing({ action: 'remove' })} />,
    );
    expect(html).toContain('Deleting can&#x27;t be undone. Consider Hide.');
  });

  it('shows server issues under the matching field', () => {
    const html = renderToStaticMarkup(
      <RuleEditor
        orgId="o"
        brandId="b"
        rule={existing({ kind: 'regex', conditions: { type: 'regex', patterns: ['a', '('] } })}
        initialIssues={[{ path: 'conditions.patterns.1', message: 'Unclosed group' }]}
      />,
    );
    expect(html).toContain('Unclosed group');
    expect(html.indexOf('Unclosed group')).toBeGreaterThan(html.indexOf('name="patterns"'));
  });
});
