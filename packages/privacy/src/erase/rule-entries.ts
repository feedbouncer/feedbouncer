import type pg from 'pg';
import type { Platform } from '@feedbouncer/connectors';
import {
  mapAuthorConditions,
  normalizeAuthorHandle,
  type AuthorConditionNode,
  type RuleConditions,
} from '@feedbouncer/rules';
import type { SubjectIdentifierT } from '../subject/identifier.js';

/** The identifiers of one subject on one platform, as rule entries are matched against them. */
export interface EntryMatch {
  platform: Platform;
  /** Compared with exact equality. */
  externalIds: ReadonlySet<string>;
  /** Compared after the rules package's handle normalization. */
  handles: ReadonlySet<string>;
}

export const ERASED = '[erased]';

/** Any author condition, at any depth of a stored JSON value. */
export const AUTHOR_NODE = `'$.** ? (@.type == "author")'`;

export interface AuthorRule {
  id: string;
  brand_id: string;
  name: string;
  conditions: unknown;
  enabled: boolean;
}

/** Every rule of the organization (every brand, archived too) that can hold author entries. */
export async function authorRules(
  c: pg.Pool | pg.ClientBase,
  organizationId: string,
): Promise<AuthorRule[]> {
  const { rows } = await c.query<AuthorRule>(
    `SELECT id, brand_id, name, conditions, enabled FROM rule
      WHERE organization_id = $1 AND (kind = 'author' OR conditions @? ${AUTHOR_NODE})
      ORDER BY id`,
    [organizationId],
  );
  return rows;
}

/** One EntryMatch per platform named in the request. */
export function entryMatches(subjects: readonly SubjectIdentifierT[]): EntryMatch[] {
  const by = new Map<Platform, { externalIds: Set<string>; handles: Set<string> }>();
  for (const s of subjects) {
    let m = by.get(s.platform);
    if (!m) by.set(s.platform, (m = { externalIds: new Set(), handles: new Set() }));
    if (s.externalId !== undefined) m.externalIds.add(s.externalId);
    if (s.handle !== undefined) m.handles.add(s.handle);
  }
  return [...by].map(([platform, m]) => ({ platform, ...m }));
}

type Entry = AuthorConditionNode['entries'][number];

export type MatchedBy = 'externalId' | 'handle';

function matcher(m: EntryMatch): (e: Entry) => MatchedBy | null {
  const handles = new Set([...m.handles].map(normalizeAuthorHandle));
  return (e) => {
    if (typeof e.externalId === 'string' && m.externalIds.has(e.externalId)) return 'externalId';
    if (typeof e.handle === 'string' && handles.has(normalizeAuthorHandle(e.handle)))
      return 'handle';
    return null;
  };
}

/** One rule entry naming the subject, without the entry's own values. */
export interface FoundEntry {
  list: string | null;
  platform: string;
  matchedBy: MatchedBy;
}

/** The subject's entries in every author condition of a stored JSON value. */
export function findAuthorEntries(value: unknown, matches: readonly EntryMatch[]): FoundEntry[] {
  const hits = matches.map((m) => ({ platform: m.platform, hit: matcher(m) }));
  const found: FoundEntry[] = [];
  mapAuthorConditions(value, (node) => {
    const list = typeof node.list === 'string' ? node.list : null;
    for (const h of hits) {
      if (h.platform !== node.platform) continue;
      for (const e of node.entries) {
        const matchedBy = h.hit(e);
        if (matchedBy) found.push({ list, platform: node.platform, matchedBy });
      }
    }
    return node;
  });
  return found;
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
    const entries = node.entries.filter((e) => hit(e) === null);
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
