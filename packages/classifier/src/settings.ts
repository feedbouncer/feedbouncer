import { RULE_ACTIONS } from '@feedbouncer/rules';
import { z } from 'zod';
import { CATEGORIES } from './types.js';

export const thresholdValue = z
  .number({ error: 'Threshold must be a number between 0 and 1.' })
  .min(0, { error: 'Threshold must be between 0 and 1.' })
  .max(1, { error: 'Threshold must be between 0 and 1.' })
  .refine((v) => Math.round(v * 10_000) / 10_000 === v, {
    error: 'Threshold can have at most 4 decimal places.',
  });

export const thresholdItemSchema = z.union([
  z.strictObject({
    category: z.enum(CATEGORIES),
    threshold: thresholdValue,
    action: z.enum(RULE_ACTIONS),
  }),
  z.strictObject({ category: z.enum(CATEGORIES), useDefault: z.literal(true) }),
]);
export type ThresholdItem = z.output<typeof thresholdItemSchema>;

const items = z
  .array(thresholdItemSchema)
  .min(1)
  .max(CATEGORIES.length)
  .refine((xs) => new Set(xs.map((x) => x.category)).size === xs.length, {
    error: 'Each category can appear only once.',
  });

export const thresholdUpdateSchema = z.strictObject({ categories: items });
export const previewRequestSchema = z.strictObject({
  categories: items,
  days: z.number().int().min(1).max(30).default(7),
});
export const rerunRequestSchema = z.strictObject({
  days: z.number().int().min(1).max(30).default(7),
});

export interface ThresholdIssue {
  path: string;
  message: string;
}

/**
 * Flat, per-field issues for a failed update or preview body. The item union
 * is reduced to the branch the item was written for (the one with the fewest
 * problems), and item messages carry their category.
 */
export function thresholdIssues(error: z.ZodError, body: unknown): ThresholdIssue[] {
  const flat = (issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] =>
    issues.flatMap((i) => {
      if (i.code !== 'invalid_union') return [i];
      const branches = i.errors
        .map(flat)
        .filter((b) => b.length > 0)
        .map((b) => b.map((x) => ({ ...x, path: [...i.path, ...x.path] })));
      if (branches.length === 0) return [i];
      return branches.reduce((best, b) => (b.length < best.length ? b : best));
    });
  const list = (body as { categories?: unknown } | null)?.categories;
  return flat(error.issues).map((i) => {
    const [root, idx] = i.path;
    const item =
      root === 'categories' && typeof idx === 'number' && Array.isArray(list) ? list[idx] : null;
    const category = (item as { category?: unknown } | null)?.category;
    const prefix =
      typeof category === 'string' && CATEGORIES.some((c) => c === category) ? `${category}: ` : '';
    return { path: i.path.join('.'), message: `${prefix}${i.message}`.slice(0, 300) };
  });
}
