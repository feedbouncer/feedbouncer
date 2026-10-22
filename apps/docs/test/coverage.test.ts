import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_DOMAINS_PER_BRAND, MAX_RULES_PER_BRAND } from '@feedbouncer/rules';
import reference from '../../../docs/reference/product-reference.json';
import { exampleFiles } from './lib/examples';
import { appRoot, body, headings } from './lib/content';

const rules = reference.rules;
const page = (name: string) => join(appRoot, 'docs/rules', name);
const h3s = (name: string) =>
  headings(body(page(name)))
    .filter((h) => h.depth === 3)
    .map((h) => h.text);

describe('rules section coverage', () => {
  it('the reference data lists the conditions and steps the pages are written for', () => {
    expect(rules.conditions.map((c) => c.type)).toEqual([
      'keyword',
      'regex',
      'link_domain',
      'emoji',
      'author',
      'competitor',
    ]);
    expect(rules.steps.map((s) => s.type)).toEqual([
      'flag_for_review',
      'private_reply',
      'auto_reply',
      'hide',
      'ban',
      'delete',
    ]);
  });

  it('conditions.mdx has exactly one "### `<type>`" per condition type', () => {
    expect(h3s('conditions.mdx')).toEqual(rules.conditions.map((c) => `\`${c.type}\``));
  });

  it('conditions.mdx summarises every condition type in its table', () => {
    const text = body(page('conditions.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="conditions"/);
    for (const { type } of rules.conditions) expect(text, type).toMatch(new RegExp(`\\b${type}:`));
  });

  it('actions.mdx has exactly one "### `<step>`" per step type and a Conflicts section', () => {
    expect(h3s('actions.mdx')).toEqual(rules.steps.map((s) => `\`${s.type}\``));
    expect(headings(body(page('actions.mdx')))).toContainEqual({ depth: 2, text: 'Conflicts' });
  });

  it('actions.mdx explains every conflict in the reference data', () => {
    const text = body(page('actions.mdx'));
    expect(text).toMatch(/<ReferenceTable\s+kind="conflicts"/);
    for (const [a, b] of rules.conflicts) expect(text, `${a}+${b}`).toContain(`'${a}+${b}'`);
  });

  it('actions.mdx names the confirm flags the code requires', () => {
    const text = body(page('actions.mdx'));
    for (const flag of ['confirmIrreversible', 'confirmHardToReverse'])
      expect(text).toContain(flag);
  });

  it('limits.mdx is built from the reference limits and states the brand limits', () => {
    const text = body(page('limits.mdx'));
    expect(text).toContain('rules.limits');
    expect(text).toContain(`${MAX_RULES_PER_BRAND} rules per brand`);
    expect(text).toContain(`${MAX_DOMAINS_PER_BRAND} own domains per brand`);
  });

  it('precedence.md covers no-match behaviour and the rule budget', () => {
    expect(headings(body(page('precedence.md')))).toContainEqual({
      depth: 2,
      text: 'When no rule matches',
    });
    expect(body(page('precedence.md'))).toContain(`${rules.ruleBudgetMs} ms`);
  });

  it('examples.mdx renders every example file once', () => {
    const text = body(page('examples.mdx'));
    for (const file of exampleFiles()) {
      const id = /^\s*import\s+(\w+)\s+from\s+'\.\/examples\/([^']+)';?\s*$/gm;
      const idents = [...text.matchAll(id)].filter((m) => m[2] === file).map((m) => m[1]!);
      expect(idents, `${file} imported once`).toHaveLength(1);
      const uses = text.match(new RegExp(`<WorkedExample\\s+data=\\{${idents[0]}\\}`, 'g'));
      expect(uses, `${file} rendered once`).toHaveLength(1);
    }
  });

  it('repeated-comments example labels duplicate detection as not supported', () => {
    expect(body(page('examples.mdx'))).toMatch(
      /<FeatureStatus status="unsupported">[\s\S]*duplicate[\s\S]*<\/FeatureStatus>/i,
    );
  });
});
