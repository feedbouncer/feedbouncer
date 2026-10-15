import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { Platform } from '@feedbouncer/connectors';

export const RuleEvaluatePayload = z
  .strictObject({
    commentId: z.uuid(),
    /** sha256 (hex) of the stored body this job evaluates; a newer edit has its own job. */
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    trigger: z.enum(['ingest', 'history']),
    /** The rule_run id; present exactly for history runs. */
    runId: z.uuid().optional(),
  })
  .refine((p) => (p.trigger === 'history') === (p.runId !== undefined), {
    message: 'runId is required for history runs and only for them.',
  });
export type RuleEvaluatePayload = z.output<typeof RuleEvaluatePayload>;

export const RULE_EVALUATE_JOB = {
  type: 'rule_evaluate' as const,
  payload: RuleEvaluatePayload,
  // One job per (comment, body version, trigger). 128 bits of the sha keep the ref short.
  externalRef: (p: RuleEvaluatePayload): string =>
    `${p.commentId}:${p.bodySha256.slice(0, 32)}:${p.trigger === 'ingest' ? 'i' : p.runId}`,
  timeoutMs: 30_000,
  platforms: 'all' as readonly Platform[] | 'all',
};

/** sha256 (hex) of a stored comment body, as UTF-8. */
export const bodySha256 = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');
