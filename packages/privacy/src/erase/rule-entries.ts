import type { Platform } from '@feedbouncer/connectors';
import {
  mapAuthorConditions,
  normalizeAuthorHandle,
  type AuthorConditionNode,
  type RuleConditions,
} from '@feedbouncer/rules';

/** The identifiers of one subject on one platform, as rule entries are matched against them. */
export interface EntryMatch {
  platform: Platform;
  /** Compared with exact equality. */
  externalIds: ReadonlySet<string>;
  /** Compared after the rules package's handle normalization. */
  handles: ReadonlySet<string>;
}

export const ERASED = '[erased]';

type Entry = AuthorConditionNode['entries'][number];

function matcher(m: EntryMatch): (e: Entry) => boolean {
  const handles = new Set([...m.handles].map(normalizeAuthorHandle));
  return (e) =>
    (typeof e.externalId === 'string' && m.externalIds.has(e.externalId)) ||
    (typeof e.handle === 'string' && handles.has(normalizeAuthorHandle(e.handle)));
}

/**
 * Removes the subject's entries from every author condition of the platform. `emptied` is
 * true when a condition that had entries is left with none (the rule must then be disabled).
 */
export function removeAuthorEntries(
  conditions: RuleConditions,
  m: EntryMatch,
): { conditions: RuleConditions; removed: number; emptied: boolean } {
  const hit = matcher(m);
  let removed = 0;
  let emptied = false;
  const out = mapAuthorConditions(conditions, (node) => {
    if (node.platform !== m.platform) return node;
    const entries = node.entries.filter((e) => !hit(e));
    const gone = node.entries.length - entries.length;
    if (gone === 0) return node;
    removed += gone;
    if (entries.length === 0) emptied = true;
    return { ...node, entries };
  });
  return removed === 0
    ? { conditions, removed: 0, emptied: false }
    : { conditions: out as RuleConditions, removed, emptied };
}

/**
 * Replaces the id and handle of every matching entry, anywhere in a stored JSON value
 * (a proposal snapshot or diff), with "[erased]". Counts the entries redacted.
 */
export function redactAuthorEntries(
  value: unknown,
  matches: readonly EntryMatch[],
): { value: unknown; redacted: number } {
  const hits = matches.map((m) => ({ platform: m.platform, hit: matcher(m) }));
  let redacted = 0;
  const out = mapAuthorConditions(value, (node) => ({
    ...node,
    entries: node.entries.map((e) => {
      if (!hits.some((h) => h.platform === node.platform && h.hit(e))) return e;
      redacted += 1;
      const r: Entry = { ...e };
      if (r.externalId !== undefined) r.externalId = ERASED;
      if (r.handle !== undefined) r.handle = ERASED;
      return r;
    }),
  }));
  return redacted === 0 ? { value, redacted: 0 } : { value: out, redacted };
}
