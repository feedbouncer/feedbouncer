import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionCapabilitiesDto } from '../../lib/actions';
import type { RuleView } from '../../lib/rules';
import { RuleEditor } from './rule-editor';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const entry = (platform: string, supported: boolean) => ({
  platform,
  connectionId: platform,
  supported,
  missingScopes: [],
  maxChars: null,
});

const CAPS: ActionCapabilitiesDto = {
  steps: {
    flag_for_review: { platforms: [entry('instagram', true)] },
    private_reply: { platforms: [entry('instagram', true)] },
    auto_reply: { platforms: [entry('instagram', true)] },
    hide: { platforms: [entry('instagram', true)] },
    ban: { platforms: [entry('instagram', false)] },
    delete: { platforms: [entry('instagram', true)] },
  },
};

const editor = (props: Partial<Parameters<typeof RuleEditor>[0]> = {}) =>
  renderToStaticMarkup(<RuleEditor orgId="o" brandId="b" capabilities={CAPS} {...props} />);

const existing = (over: Partial<RuleView>): RuleView => ({
  id: 'r1',
  name: 'Existing',
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

/** The opening tag of the checkbox for a step. */
const stepBox = (html: string, type: string) =>
  new RegExp(`<input[^>]*name="step-${type}"[^>]*>`).exec(html)?.[0];

describe('RuleEditor', () => {
  it('starts a new rule as a dry run', () => {
    const html = editor();
    expect(html).toMatch(/<input[^>]*name="dryRun"[^>]*checked=""/);
  });

  it('shows an enforced rule as not a dry run', () => {
    const html = editor({ rule: existing({}) });
    expect(html).not.toMatch(/<input[^>]*name="dryRun"[^>]*checked/);
  });

  it('starts a new rule with only Flag for review ticked', () => {
    const html = editor();
    expect(stepBox(html, 'flag_for_review')).toContain('checked');
    expect(stepBox(html, 'hide')).not.toContain('checked');
    expect(stepBox(html, 'delete')).not.toContain('checked');
  });

  it("shows a saved rule's steps ticked", () => {
    const html = editor({
      rule: existing({
        actions: [{ type: 'hide' }, { type: 'delete', confirmIrreversible: true }],
      }),
    });
    expect(stepBox(html, 'hide')).toContain('checked');
    expect(stepBox(html, 'delete')).toContain('checked');
    expect(html).not.toContain('name="action"');
  });

  it('offers no steps for an allow list', () => {
    const html = editor({
      rule: existing({
        kind: 'author',
        action: 'approve',
        actions: [],
        conditions: { type: 'author', list: 'allow', platform: 'facebook', entries: [] },
      }),
    });
    expect(html).not.toContain('name="step-');
    expect(html).toContain('always allowed');
  });

  it('offers steps for a block list, limited to its platform', () => {
    const html = editor({
      rule: existing({
        kind: 'author',
        conditions: { type: 'author', list: 'block', platform: 'instagram', entries: [] },
      }),
    });
    expect(stepBox(html, 'hide')).toBeDefined();
    expect(stepBox(html, 'ban')).toBeUndefined();
  });

  it('shows step problems under the step, not as a general error', () => {
    const html = editor({
      rule: existing({}),
      initialIssues: [{ path: 'actions.0', message: 'not_supported_anywhere' }],
    });
    expect(html).toContain('None of the connected accounts support this.');
  });

  it('shows server issues under the matching field', () => {
    const html = renderToStaticMarkup(
      <RuleEditor
        orgId="o"
        brandId="b"
        capabilities={CAPS}
        rule={existing({ kind: 'regex', conditions: { type: 'regex', patterns: ['a', '('] } })}
        initialIssues={[{ path: 'conditions.patterns.1', message: 'Unclosed group' }]}
      />,
    );
    expect(html).toContain('Unclosed group');
    expect(html.indexOf('Unclosed group')).toBeGreaterThan(html.indexOf('name="patterns"'));
  });
});
