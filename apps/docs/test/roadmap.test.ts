import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { body, links, repoRoot } from './lib/content';
import { DISCLAIMER, EMPTY_GROUP, GROUPS, parseRoadmap, ROADMAP_FILE } from './lib/roadmap';

describe('roadmap page', () => {
  const md = readFileSync(ROADMAP_FILE, 'utf8');
  const r = parseRoadmap(md);
  const section = (name: string) => md.split(`\n## ${name}\n`)[1]!.split('\n## ')[0]!;

  it('has one h1 and the four groups first, in order', () => {
    expect(r.h1).toEqual(['Roadmap']);
    expect(r.h2.slice(0, 4)).toEqual([...GROUPS]);
    expect(r.h2).toContain('Suggest an item');
  });
  it('opens with the one-line disclaimer', () => expect(r.disclaimer).toBe(DISCLAIMER));
  it('Last updated is a real YYYY-MM-DD date, not in the future', () => {
    const d = new Date(`${r.lastUpdated}T00:00:00Z`);
    expect(d.toISOString().slice(0, 10)).toBe(r.lastUpdated); // rejects 2026-02-30
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000); // one day of time-zone slack
  });
  it('no item title appears in more than one group', () => {
    const titles = GROUPS.flatMap((g) => r.groups[g].items.map((i) => i.title.toLowerCase()));
    expect(new Set(titles).size).toBe(titles.length);
  });
  it('parseRoadmap requires "Nothing here yet." in an empty group', () => {
    const later = section('Later');
    expect(() => parseRoadmap(md.replace(later, '\n'))).toThrow(/Later/);
    expect(parseRoadmap(md.replace(later, `\n${EMPTY_GROUP}\n`)).groups.Later.empty).toBe(true);
    expect(() => parseRoadmap(md.replace(later, `${later}${EMPTY_GROUP}\n`))).toThrow(/Later/);
  });
  it('parseRoadmap rejects a malformed item line', () => {
    expect(() =>
      parseRoadmap(md.replace('\n## Now\n', '\n## Now\n\n- Title without bold\n')),
    ).toThrow(/Now: malformed/);
  });
  it('page is plain Markdown: no HTML, JSX, braces, images or tables', () => {
    for (const re of [/</, /[{}]/, /!\[/, /^import\s/m, /^\|/m])
      expect(body(ROADMAP_FILE)).not.toMatch(re);
  });
  it('items make no delivery promises and leak no internal detail', () => {
    const DENY = [
      /\b20\d\d\b/,
      /\bQ[1-4]\b/,
      /\bv\d+(\.\d+)*\b/,
      /\b(soon|guarantee|by the end|next (week|month|quarter))/i,
      /\bphase\s*\d/i,
      /\bitem\s*\d/i,
      /#\d+/,
      /\b(ECS|RDS|VPC|ALB|Terraform|AWS|Fargate)\b/,
      /feedbouncer-cloud/i,
      /pric(e|ing)|paddle|billing/i,
      /\bpartner/i,
    ];
    for (const g of GROUPS)
      for (const i of r.groups[g].items)
        for (const re of DENY)
          expect(`${i.title} ${i.description}`, `${g}: ${i.title} ~ ${re}`).not.toMatch(re);
  });
  it('every link is absolute https to the public product repo', () => {
    for (const href of links(md))
      expect(href).toMatch(/^https:\/\/github\.com\/feedbouncer\/feedbouncer\//);
  });
  it('Suggest an item links an issue form that exists', () => {
    const name = section('Suggest an item').match(/issues\/new\?template=([a-z_]+\.yml)\)/)?.[1];
    expect(name).toBe('roadmap_suggestion.yml');
    expect(existsSync(join(repoRoot, '.github/ISSUE_TEMPLATE', name!))).toBe(true);
  });
});
