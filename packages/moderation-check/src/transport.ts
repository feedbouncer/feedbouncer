import { z } from 'zod';
import { prepareInput } from '@feedbouncer/ai';
import { MAX_CHECK_TEXT_UNITS } from '@feedbouncer/moderation-contract';
import type { CheckResult } from './types.js';

export const MODERATION_CHECK_QUEUE = 'moderation-check';
export { MAX_CHECK_TEXT_UNITS };

export const CheckJobData = z.strictObject({
  v: z.literal(1),
  organizationId: z.uuid(),
  brandId: z.uuid(),
  text: z.string().min(1).max(MAX_CHECK_TEXT_UNITS),
  deadlineAt: z.number().int().positive(),
});
export type CheckJobData = z.infer<typeof CheckJobData>;

export type CheckJobResult =
  | { kind: 'done'; result: CheckResult }
  | { kind: 'expired' }
  | { kind: 'brand_gone' };

export function validateCheckText(
  text: string,
): { ok: true } | { ok: false; problem: 'malformed' | 'empty' | 'too_long' } {
  if (!text.isWellFormed() || text.includes('\u0000')) return { ok: false, problem: 'malformed' };
  if (text.length > MAX_CHECK_TEXT_UNITS) return { ok: false, problem: 'too_long' };
  if (prepareInput(text).empty) return { ok: false, problem: 'empty' };
  return { ok: true };
}
