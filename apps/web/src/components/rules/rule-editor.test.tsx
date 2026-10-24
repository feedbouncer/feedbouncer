import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionCapabilitiesDto } from '../../lib/actions';
import { emptyForm, ruleRequestBody, type RuleView } from '../../lib/rules';
import { RuleEditor, SaveWarnings } from './rule-editor';

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
  appliesTo: 'all',
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
    expect(html).toMatch(/<input[^>]*name="confirm-delete"[^>]*checked=""/);
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

describe('applies to', () => {
  /** The opening tag of the selected option of a select. */
  const selected = (html: string, name: string) => {
    const start = html.indexOf(`name="${name}"`);
    const select = html.slice(start, html.indexOf('</select>', start));
    return /<option value="([a-z]+)" selected="">/.exec(select)?.[1];
  };

  it('offers all comments, organic only and ads only; a new rule applies to all', () => {
    const html = editor();
    expect(html).toContain('Applies to');
    expect(html).toContain('<option value="all" selected="">All comments</option>');
    expect(html).toContain('<option value="organic">Organic only</option>');
    expect(html).toContain('<option value="ad">Ads only</option>');
  });

  it("shows a saved rule's scope", () => {
    expect(selected(editor({ rule: existing({ appliesTo: 'ad' }) }), 'appliesTo')).toBe('ad');
  });

  it('the rules editor submits appliesTo', () => {
    const body = ruleRequestBody({
      name: 'Ad spam',
      kind: 'keyword',
      form: { ...emptyForm(), keywordTerms: 'spam' },
      actions: [{ type: 'hide' }],
      dryRun: false,
      appliesTo: 'ad',
    });
    expect(body).toEqual({
      name: 'Ad spam',
      conditions: { type: 'keyword', terms: ['spam'], match: 'whole_word' },
      actions: [{ type: 'hide' }],
      mode: 'enforce',
      appliesTo: 'ad',
    });
  });
});

describe('SaveWarnings', () => {
  it('keeps the user on the page to read what the saved rule still lacks', () => {
    const html = renderToStaticMarkup(
      <SaveWarnings
        rulesHref="/orgs/o/brands/b/rules"
        ruleHref="/orgs/o/brands/b/rules/r1"
        warnings={[
          {
            type: 'private_reply',
            code: 'missing_permission',
            platform: 'instagram',
            connectionId: 'c1',
            scopes: ['instagram_manage_messages'],
          },
        ]}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Rule saved');
    expect(html).toContain('instagram_manage_messages');
    expect(html).toContain('href="/orgs/o/brands/b/rules"');
    expect(html).toContain('href="/orgs/o/brands/b/rules/r1"');
  });
});
