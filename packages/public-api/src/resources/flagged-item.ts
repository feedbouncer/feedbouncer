import { z } from 'zod';
import { CommentResource } from './comment.js';

export const FlaggedItemResource = z
  .object({
    id: z.uuid(),
    brandId: z.uuid(),
    commentId: z.uuid(),
    source: z.enum(['rule', 'classifier', 'policy', 'user', 'action_step']),
    ruleId: z.uuid().nullable(),
    status: z.enum(['open', 'resolved']),
    resolution: z.string().nullable(),
    createdAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    comment: CommentResource.nullable(),
  })
  .meta({ id: 'FlaggedItem' });

/** Columns the review-item queries select. */
export interface FlaggedItemRow {
  id: string;
  brandId: string;
  commentId: string;
  source: 'rule' | 'classifier' | 'policy' | 'user' | 'action_step';
  ruleId: string | null;
  status: 'open' | 'resolved';
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export function toFlaggedItemResource(
  row: FlaggedItemRow,
  comment: z.output<typeof CommentResource> | null,
): z.output<typeof FlaggedItemResource> {
  return {
    id: row.id,
    brandId: row.brandId,
    commentId: row.commentId,
    source: row.source,
    ruleId: row.ruleId,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    comment,
  };
}
