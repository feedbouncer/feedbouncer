import { describe, expect, it } from 'vitest';
import { checkOverbroad, PROBE_TEXTS } from './overbroad.js';
import type { RuleConditions } from './conditions.js';

const regex = (...patterns: string[]): RuleConditions => ({ type: 'regex', patterns });
const keyword = (...terms: string[]): RuleConditions => ({
  type: 'keyword',
  terms,
  match: 'whole_word',
});

describe('checkOverbroad', () => {
  it('flags regexes that match every probe', () => {
    expect(checkOverbroad(regex('.*'))).toBe('matches_everything');
    expect(checkOverbroad(regex('.'))).toBe('matches_everything');
  });
  it('flags a regex that matches the empty string', () => {
    expect(checkOverbroad(regex('x?'))).toBe('matches_everything');
    expect(checkOverbroad(regex('crypto', '^$|x*'))).toBe('matches_everything');
  });
  it('accepts targeted rules', () => {
    expect(checkOverbroad(keyword('crypto giveaway'))).toBeNull();
    expect(checkOverbroad(regex('^\\d+$'))).toBeNull();
    expect(checkOverbroad(keyword())).toBeNull();
  });
  it('probes a varied set of texts', () => {
    expect(PROBE_TEXTS).toHaveLength(8);
  });
});
