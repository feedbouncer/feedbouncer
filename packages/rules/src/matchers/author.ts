import type { AuthorConditions } from '../conditions.js';
import { normalizeText } from '../normalize.js';
import type { Matcher } from './types.js';

const normHandle = (h: string) => normalizeText(h.replace(/^@/, '')).trim();

export function compileAuthorRule(c: AuthorConditions): Matcher {
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const e of c.entries) {
    if (e.externalId !== undefined) ids.add(e.externalId);
    else if (e.handle !== undefined) {
      const h = normHandle(e.handle);
      if (h.length > 0) handles.add(h); // handle-only entries
    }
  }
  return (v) => {
    if (v.facts.platform !== c.platform) return null;
    const id = v.facts.authorExternalId;
    if (id !== null && ids.has(id)) return { kind: 'author', list: c.list, matchedOn: 'id' };
    const name = v.facts.authorName;
    if (name !== null) {
      const h = normHandle(name);
      if (h.length > 0 && handles.has(h))
        return { kind: 'author', list: c.list, matchedOn: 'handle' };
    }
    return null;
  };
}
