import type { ClassifierEvidence } from './classifier';

export const RULE_ACTIONS = ['approve', 'flag', 'hide', 'remove'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export type RuleMode = 'enforce' | 'suggest';
export const RULE_KINDS = [
  'keyword',
  'regex',
  'link_domain',
  'emoji',
  'author',
  'competitor',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const ACTION_LABEL: Record<RuleAction, string> = {
  approve: 'Allow',
  flag: 'Flag for review',
  hide: 'Hide',
  remove: 'Delete',
};

export const KIND_LABEL: Record<RuleKind, string> = {
  keyword: 'Keywords',
  regex: 'Patterns',
  link_domain: 'Link domains',
  emoji: 'Emoji',
  author: 'Authors',
  competitor: 'Competitor mentions',
};

export const RULE_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
  'meta_ads',
] as const;

export interface RuleView {
  id: string;
  name: string;
  kind: RuleKind | null;
  conditions: unknown;
  action: RuleAction;
  mode: RuleMode;
  enabled: boolean;
  position: number;
  warnings: {
    shadowedBy: { id: string; name: string } | null;
    neverMatches: boolean;
    invalid: boolean;
  };
}

export interface DecisionView {
  id: string;
  outcome: RuleAction;
  mode: RuleMode;
  actorType: 'user' | 'rule' | 'classifier';
  rule: { id: string; name: string; kind: RuleKind | null; archived: boolean } | null;
  reason: string;
  createdAt: string;
  fallback: boolean;
  action: { kind: string; status: string; outcomeCode: string | null } | null;
  classifier: ClassifierEvidence | null;
}

export interface ActivityView extends DecisionView {
  commentId: string;
  commentExcerpt: string;
  platform: string;
}

export const linesToList = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

export const listToLines = (xs: string[]): string => xs.join('\n');

const words = (text: string): string[] => text.split(/[\s,]+/).filter((w) => w.length > 0);

/** Every field of the editor, as text and booleans; each kind reads its own subset. */
export interface RuleFormState {
  keywordTerms: string;
  keywordMatch: 'whole_word' | 'contains';
  regexPatterns: string;
  linkMode: 'blocklist' | 'allowlist';
  linkDomains: string;
  exemptOwnDomains: boolean;
  matchShorteners: boolean;
  matchLookalikes: boolean;
  emojiList: string;
  emojiMaxCount: string;
  authorList: 'block' | 'allow' | 'trusted';
  authorPlatform: string;
  authorEntries: string;
  competitorNames: string;
  competitorHandles: string;
  competitorDomains: string;
}

export const emptyForm = (): RuleFormState => ({
  keywordTerms: '',
  keywordMatch: 'whole_word',
  regexPatterns: '',
  linkMode: 'blocklist',
  linkDomains: '',
  exemptOwnDomains: true,
  matchShorteners: true,
  matchLookalikes: true,
  emojiList: '',
  emojiMaxCount: '',
  authorList: 'block',
  authorPlatform: 'facebook',
  authorEntries: '',
  competitorNames: '',
  competitorHandles: '',
  competitorDomains: '',
});

interface AuthorEntry {
  externalId?: string;
  handle?: string;
}

function parseAuthorLine(line: string): AuthorEntry {
  const entry: AuthorEntry = {};
  for (const token of line.split(/\s+/)) {
    if (token.startsWith('id:')) entry.externalId = token.slice(3);
    else entry.handle = token.replace(/^@/, '');
  }
  return entry;
}

const authorLine = (e: AuthorEntry): string =>
  [
    e.externalId === undefined ? null : `id:${e.externalId}`,
    e.handle === undefined ? null : `@${e.handle}`,
  ]
    .filter((p) => p !== null)
    .join(' ');

export function conditionsFromForm(kind: RuleKind, f: RuleFormState): unknown {
  switch (kind) {
    case 'keyword':
      return { type: 'keyword', terms: linesToList(f.keywordTerms), match: f.keywordMatch };
    case 'regex':
      return { type: 'regex', patterns: linesToList(f.regexPatterns) };
    case 'link_domain':
      return {
        type: 'link_domain',
        mode: f.linkMode,
        domains: linesToList(f.linkDomains),
        exemptOwnDomains: f.exemptOwnDomains,
        shorteners: f.matchShorteners ? 'match' : 'ignore',
        lookalikes: f.matchLookalikes ? 'match' : 'ignore',
      };
    case 'emoji': {
      const max = f.emojiMaxCount.trim();
      return {
        type: 'emoji',
        emoji: words(f.emojiList),
        maxCount: max === '' ? null : Number(max),
      };
    }
    case 'author':
      return {
        type: 'author',
        list: f.authorList,
        platform: f.authorPlatform,
        entries: linesToList(f.authorEntries).map(parseAuthorLine),
      };
    case 'competitor':
      return {
        type: 'competitor',
        names: linesToList(f.competitorNames),
        handles: linesToList(f.competitorHandles),
        domains: linesToList(f.competitorDomains),
      };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function formFromConditions(c: unknown): RuleFormState {
  const f = emptyForm();
  if (!isRecord(c)) return f;
  switch (c.type) {
    case 'keyword':
      f.keywordTerms = listToLines(strings(c.terms));
      if (c.match === 'contains') f.keywordMatch = 'contains';
      break;
    case 'regex':
      f.regexPatterns = listToLines(strings(c.patterns));
      break;
    case 'link_domain':
      if (c.mode === 'allowlist') f.linkMode = 'allowlist';
      f.linkDomains = listToLines(strings(c.domains));
      f.exemptOwnDomains = c.exemptOwnDomains !== false;
      f.matchShorteners = c.shorteners !== 'ignore';
      f.matchLookalikes = c.lookalikes !== 'ignore';
      break;
    case 'emoji':
      f.emojiList = strings(c.emoji).join(' ');
      f.emojiMaxCount = typeof c.maxCount === 'number' ? String(c.maxCount) : '';
      break;
    case 'author':
      if (c.list === 'allow' || c.list === 'trusted') f.authorList = c.list;
      if (typeof c.platform === 'string') f.authorPlatform = c.platform;
      f.authorEntries = listToLines(
        (Array.isArray(c.entries) ? c.entries : []).filter(isRecord).map((e) =>
          authorLine({
            ...(typeof e.externalId === 'string' && { externalId: e.externalId }),
            ...(typeof e.handle === 'string' && { handle: e.handle }),
          }),
        ),
      );
      break;
    case 'competitor':
      f.competitorNames = listToLines(strings(c.names));
      f.competitorHandles = listToLines(strings(c.handles));
      f.competitorDomains = listToLines(strings(c.domains));
      break;
  }
  return f;
}

export interface RuleIssue {
  path: string;
  message: string;
}

/** The actions a rule of this kind may take; author lists are tied to allow or block. */
export function allowedActions(kind: RuleKind, f: RuleFormState): readonly RuleAction[] {
  if (kind !== 'author') return RULE_ACTIONS;
  return f.authorList === 'block' ? RULE_ACTIONS.filter((a) => a !== 'approve') : ['approve'];
}
