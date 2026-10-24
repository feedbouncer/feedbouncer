import { actionStepsSchema, deriveOutcome, type ActionStep } from '@feedbouncer/actions';
import { PLATFORMS } from '@feedbouncer/connectors';
import { z } from 'zod';
import { normalizeDomainEntry } from './domains.js';
import { isSingleEmoji } from './emoji.js';
import { normalizeText } from './normalize.js';
import { compilePattern, RegexCompileError } from './regex.js';
import { RULE_APPLIES_TO, RULE_MODES } from './types.js';

export const CONDITION_LIMITS = {
  terms: 5000,
  termChars: 100,
  patterns: 20,
  domains: 1000,
  emoji: 200,
  maxCount: 500,
  authorEntries: 5000,
  idChars: 255,
  handleChars: 100,
  competitorEach: 500,
  jsonChars: 600_000,
} as const;

const L = CONDITION_LIMITS;
const dedupe = (xs: string[]) => [...new Set(xs)];
// Terms are matched case- and accent-insensitively, so duplicates are judged on the normalised form (first spelling wins).
const dedupeTerms = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = normalizeText(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const termList = (max: number, chars: number) =>
  z
    .array(z.string().max(chars * 2))
    .max(max)
    .transform((xs) => dedupeTerms(xs.map((x) => x.trim()).filter((x) => x.length > 0)))
    .pipe(z.array(z.string().max(chars)));
const domainList = (max: number) =>
  z
    .array(z.string().max(2048))
    .max(max)
    .transform((xs, ctx) => {
      const out: string[] = [];
      xs.forEach((x, i) => {
        const d = normalizeDomainEntry(x);
        if (d === null)
          ctx.addIssue({ code: 'custom', path: [i], message: 'Not a valid domain name.' });
        else out.push(d);
      });
      return dedupe(out);
    });
const handle = z
  .string()
  .trim()
  .transform((h) => h.replace(/^@/, ''))
  .pipe(z.string().min(1).max(L.handleChars));

/** How the author matcher compares handles: leading '@' dropped, case and accents folded. */
export const normalizeAuthorHandle = (h: string): string =>
  normalizeText(h.replace(/^@/, '')).trim();

/** An author condition as found in stored JSON, before (or without) schema validation. */
export interface AuthorConditionNode {
  type: 'author';
  platform: string;
  entries: { externalId?: unknown; handle?: unknown }[];
  [key: string]: unknown;
}

const isAuthorNode = (v: unknown): v is AuthorConditionNode => {
  const o = v as Partial<AuthorConditionNode> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    o.type === 'author' &&
    typeof o.platform === 'string' &&
    Array.isArray(o.entries)
  );
};

/**
 * Pure structural walk over stored JSON (a rule's conditions, a proposal snapshot or its
 * diff): every author condition node, at any depth, is replaced by `fn(node)`. Returns a
 * new value and never mutates the input.
 */
export function mapAuthorConditions(
  value: unknown,
  fn: (node: AuthorConditionNode) => AuthorConditionNode,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapAuthorConditions(v, fn));
  if (typeof value !== 'object' || value === null) return value;
  if (isAuthorNode(value)) return fn({ ...value, entries: value.entries.map((e) => ({ ...e })) });
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapAuthorConditions(v, fn)]));
}

export const keywordConditions = z.strictObject({
  type: z.literal('keyword'),
  terms: termList(L.terms, L.termChars),
  match: z.enum(['whole_word', 'contains']).default('whole_word'),
});
export const regexConditions = z.strictObject({
  type: z.literal('regex'),
  patterns: z
    .array(z.string())
    .max(L.patterns)
    .superRefine((ps, ctx) => {
      ps.forEach((p, i) => {
        try {
          compilePattern(p);
        } catch (e) {
          if (e instanceof RegexCompileError)
            ctx.addIssue({ code: 'custom', path: [i], message: e.message });
          else throw e;
        }
      });
    }),
});
export const linkDomainConditions = z.strictObject({
  type: z.literal('link_domain'),
  mode: z.enum(['blocklist', 'allowlist']),
  domains: domainList(L.domains),
  exemptOwnDomains: z.boolean().default(true),
  shorteners: z.enum(['match', 'ignore']).default('match'),
  lookalikes: z.enum(['match', 'ignore']).default('match'),
});
export const emojiConditions = z
  .strictObject({
    type: z.literal('emoji'),
    emoji: z
      .array(z.string().max(64))
      .max(L.emoji)
      .superRefine((es, ctx) => {
        es.forEach((e, i) => {
          if (!isSingleEmoji(e))
            ctx.addIssue({
              code: 'custom',
              path: [i],
              message: 'Each entry must be a single emoji.',
            });
        });
      })
      .transform(dedupe),
    maxCount: z.number().int().min(0).max(L.maxCount).nullable().default(null),
  })
  .refine((c) => c.emoji.length > 0 || c.maxCount !== null, {
    message: 'List at least one emoji or set a maximum count.',
  });
export const authorConditions = z
  .strictObject({
    type: z.literal('author'),
    list: z.enum(['block', 'allow', 'trusted']),
    platform: z.enum(PLATFORMS),
    entries: z
      .array(
        z
          .strictObject({
            externalId: z.string().trim().min(1).max(L.idChars).optional(),
            handle: handle.optional(),
          })
          .refine((e) => e.externalId !== undefined || e.handle !== undefined, {
            message: 'Give an author ID or a handle.',
          }),
      )
      .min(1)
      .max(L.authorEntries),
  })
  .superRefine((c, ctx) => {
    // Display names are attacker-controlled: allow/trusted lists exempt a comment from
    // later rules, so they may only be keyed on the stable platform ID.
    if (c.list === 'block') return;
    c.entries.forEach((e, i) => {
      if (e.externalId === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['entries', i],
          message: "Allow and trusted lists need the author's ID; handles can be impersonated.",
        });
    });
  });
export const competitorConditions = z
  .strictObject({
    type: z.literal('competitor'),
    names: termList(L.competitorEach, L.termChars),
    handles: z.array(handle).max(L.competitorEach).transform(dedupe),
    domains: domainList(L.competitorEach),
  })
  .refine((c) => c.names.length + c.handles.length + c.domains.length > 0, {
    message: 'List at least one name, handle or domain.',
  });

export const ruleConditionsSchema = z
  .discriminatedUnion('type', [
    keywordConditions,
    regexConditions,
    linkDomainConditions,
    emojiConditions,
    authorConditions,
    competitorConditions,
  ])
  .superRefine((c, ctx) => {
    if (JSON.stringify(c).length > L.jsonChars)
      ctx.addIssue({ code: 'custom', message: 'Rule is too large.' });
  });

export type RuleConditions = z.output<typeof ruleConditionsSchema>;
export type KeywordConditions = z.output<typeof keywordConditions>;
export type RegexConditions = z.output<typeof regexConditions>;
export type LinkDomainConditions = z.output<typeof linkDomainConditions>;
export type EmojiConditions = z.output<typeof emojiConditions>;
export type AuthorConditions = z.output<typeof authorConditions>;
export type CompetitorConditions = z.output<typeof competitorConditions>;

export function checkActionForConditions(
  c: RuleConditions,
  steps: readonly ActionStep[],
): string | null {
  if (c.type !== 'author') return null;
  if (c.list !== 'block' && steps.length > 0) return `An ${c.list} list can only allow comments.`;
  if (c.list === 'block' && deriveOutcome(steps) === 'approve')
    return 'A block list must flag, hide or delete.';
  return null;
}

const name = z.string().trim().min(1).max(200);
export const ruleInputSchema = z.strictObject({
  name,
  conditions: ruleConditionsSchema,
  actions: actionStepsSchema,
  mode: z.enum(RULE_MODES).default('suggest'),
  enabled: z.boolean().default(true),
  appliesTo: z.enum(RULE_APPLIES_TO).default('all'),
});
export const rulePatchSchema = z
  .strictObject({
    name: name.optional(),
    conditions: ruleConditionsSchema.optional(),
    actions: actionStepsSchema.optional(),
    mode: z.enum(RULE_MODES).optional(),
    enabled: z.boolean().optional(),
    appliesTo: z.enum(RULE_APPLIES_TO).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update.' });
export type RuleInput = z.output<typeof ruleInputSchema>;
export type RulePatch = z.output<typeof rulePatchSchema>;
