import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandNav, isActive, orgNav } from './nav';

const O = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('nav model', () => {
  it('every nav href resolves to an existing page.tsx', () => {
    for (const i of [...orgNav(O), ...brandNav(O, B)]) {
      const route = i.href.replace(O, '[orgId]').replace(B, '[brandId]');
      expect(existsSync(`src/app${route}/page.tsx`), route).toBe(true);
    }
  });

  it('rejects non-uuid ids', () => {
    expect(() => orgNav('../x')).toThrow('invalid id');
    expect(() => brandNav(O, 'x')).toThrow('invalid id');
    expect(() => brandNav('x', B)).toThrow('invalid id');
  });

  it('lists items in the documented order', () => {
    expect(orgNav(O).map((i) => i.label)).toEqual([
      'Overview',
      'Comments',
      'Reports',
      'Alerts',
      'Members',
      'Tags',
      'API keys',
    ]);
    expect(brandNav(O, B).map((i) => i.label)).toEqual([
      'Comments',
      'Review',
      'Suggestions',
      'Rules',
      'Policies',
      'Classifier',
      'Actions',
      'Ads',
      'Alerts',
      'Domains',
      'Connections',
    ]);
  });

  it('marks the right item active', () => {
    const [overview, comments] = orgNav(O);
    expect(isActive(`/orgs/${O}`, overview!)).toBe(true);
    expect(isActive(`/orgs/${O}/comments`, overview!)).toBe(false);
    expect(isActive(`/orgs/${O}/comments/?q=1`, comments!)).toBe(true);
    const rules = brandNav(O, B).find((i) => i.label === 'Rules')!;
    expect(isActive(`/orgs/${O}/brands/${B}/rules/activity`, rules)).toBe(true);
    expect(isActive(`/orgs/${O}/brands/${B}/rulesx`, rules)).toBe(false);
  });
});
