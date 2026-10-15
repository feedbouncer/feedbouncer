import type { CompetitorConditions } from '../conditions.js';
import { isUnder } from '../domains.js';
import { normalizeText } from '../normalize.js';
import { compileKeywords } from './keywords.js';
import type { Matcher } from './types.js';

export function compileCompetitorRule(c: CompetitorConditions): Matcher {
  const names = compileKeywords(c.names, 'whole_word');
  const handles = new Map<string, string>();
  for (const h of c.handles) {
    const k = normalizeText(h).trim();
    if (k.length > 0) handles.set(k, h);
  }
  return (v) => {
    const name = names.find(v);
    if (name !== null) return { kind: 'competitor', term: name, via: 'name' };
    for (const m of v.mentions) {
      const h = handles.get(m);
      if (h !== undefined) return { kind: 'competitor', term: h, via: 'handle' };
    }
    for (const l of v.links)
      for (const d of c.domains)
        if (isUnder(l.host, d)) return { kind: 'competitor', term: d, via: 'domain' };
    return null;
  };
}
