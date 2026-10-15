import { z } from 'zod';
import {
  MAX_NAME_CHARS,
  MAX_POLICY_CHARS,
  MIN_POLICY_CHARS,
  POLICY_ACTIONS,
  PREVIEW_MAX_DAYS,
  RUN_MAX_DAYS,
} from './types.js';

/**
 * Rejected outright (never silently normalised): C0/C1 controls except \n and \t, soft hyphen,
 * zero-width and word-joiner characters, BOM, and bidi embedding/override/isolate characters.
 */
const FORBIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** Length in Unicode code points, matching Postgres char_length. */
const len = (s: string): number => [...s].length;

export function normalizePolicyText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const words = (s: string): string[] => s.toLowerCase().match(WORD) ?? [];

/** Words that carry no checkable meaning on their own. */
const VAGUE = new Set([
  'bad',
  'stuff',
  'things',
  'thing',
  'inappropriate',
  'offensive',
  'negative',
  'annoying',
  'weird',
  'wrong',
  'mean',
  'rude',
  'toxic',
  'harmful',
  'problematic',
  'comments',
  'comment',
  'content',
  'posts',
  'hide',
  'flag',
  'delete',
  'remove',
  'any',
  'all',
  'or',
  'and',
  'the',
  'a',
  'an',
  'that',
  'are',
  'is',
  'be',
]);
const MIN_SPECIFIC_WORDS = 5;

export type PolicyWarning = 'few_words' | 'vague_terms';

/** Advisory only: the policy can still be saved. */
export function policyWarnings(text: string): PolicyWarning[] {
  const w = words(text);
  const out: PolicyWarning[] = [];
  if (w.length < MIN_SPECIFIC_WORDS) out.push('few_words');
  if (w.length > 0 && w.every((x) => VAGUE.has(x))) out.push('vague_terms');
  return out;
}

/** NFC-normalise, reject forbidden characters on the raw input, then collapse whitespace. */
const cleaned = (what: string) =>
  z.string().transform((raw, ctx) => {
    const n = raw.normalize('NFC').replace(/\r\n?/g, '\n');
    if (FORBIDDEN.test(n)) {
      ctx.issues.push({
        code: 'custom',
        message: `The ${what} contains characters that are not allowed.`,
        input: raw,
      });
      return z.NEVER;
    }
    return normalizePolicyText(n);
  });

const name = cleaned('name').pipe(
  z
    .string()
    .refine((s) => s.length > 0, 'Give the policy a name.')
    .refine(
      (s) => len(s) <= MAX_NAME_CHARS,
      `Keep the name under ${MAX_NAME_CHARS + 1} characters.`,
    )
    .refine((s) => !s.includes('\n'), 'The name must be on one line.'),
);

const text = cleaned('policy').pipe(
  z
    .string()
    .refine(
      (s) => s.length > 0,
      'Write the policy as a sentence, for example \u201CHide comments telling people to DM another account\u201D.',
    )
    .refine(
      (s) => len(s) >= MIN_POLICY_CHARS,
      `Write at least ${MIN_POLICY_CHARS} characters so the policy can be applied.`,
    )
    .refine(
      (s) => len(s) <= MAX_POLICY_CHARS,
      `Keep the policy under ${MAX_POLICY_CHARS + 1} characters.`,
    )
    .refine((s) => words(s).length >= 2, 'Write the policy as a sentence with at least two words.'),
);

const action = z.enum(POLICY_ACTIONS, { error: 'Choose Flag for review, Hide or Delete.' });

export const policyInputSchema = z.strictObject({ name, text, action });
export const policyPatchSchema = z
  .strictObject({
    name: name.optional(),
    text: text.optional(),
    action: action.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to change.');
export const previewRequestSchema = z.strictObject({
  text,
  action,
  days: z.int().min(1).max(PREVIEW_MAX_DAYS).default(7),
  policyId: z.uuid().optional(),
});
export const runRequestSchema = z.strictObject({
  days: z.int().min(1).max(RUN_MAX_DAYS).default(7),
});

export function policyIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues
    .slice(0, 10)
    .map((i) => ({ path: i.path.join('.') || '(body)', message: i.message.slice(0, 300) }));
}
