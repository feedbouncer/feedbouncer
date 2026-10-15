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
