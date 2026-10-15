import type { RegexConditions } from '../conditions.js';
import { compilePattern } from '../regex.js';
import type { Matcher } from './types.js';

export function compileRegexRule(c: RegexConditions): Matcher {
  const compiled = c.patterns.map(compilePattern);
  return (v, budget) => {
    for (let i = 0; i < compiled.length; i++) {
      if (budget.now() - budget.startedAt > budget.limitMs) return 'timeout';
      if (compiled[i]!.test(v.normalized)) return { kind: 'regex', patternIndex: i };
    }
    return null;
  };
}
