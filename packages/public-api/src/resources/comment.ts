import { z } from 'zod';
import { publicStatus, truncateText } from '../text.js';

export const CommentResource = z
  .object({
    id: z.uuid(),
    brandId: z.uuid(),
    connectionId: z.uuid(),
    platform: z.enum(['facebook', 'instagram']),
    externalId: z.string(),
    parentId: z.uuid().nullable(),
    parentRemoved: z.boolean(),
    authorName: z.string().nullable(),
    text: z.string(),
    textTruncated: z.boolean(),
    postedAt: z.iso.datetime(),
    ingestedAt: z.iso.datetime(),
    status: z.enum(['visible', 'hidden', 'flagged']),
    flagged: z.boolean(),
    permalink: z.string().nullable(),
    isOwnAccount: z.boolean(),
  })
  .meta({ id: 'Comment' });

/** Columns the comment queries select; deleted comments are never selected. */
export interface CommentRow {
  id: string;
  brandId: string;
  connectionId: string;
  platform: 'facebook' | 'instagram';
  externalId: string;
  parentId: string | null;
  parentRemoved: boolean;
  authorDisplayName: string | null;
  authorAnonymizedAt: Date | null;
  body: string;
  postedAt: Date;
  ingestedAt: Date;
  platformState: 'visible' | 'hidden';
  hasOpenReviewItem: boolean;
  permalink: string | null;
  isOwnAccount: boolean;
}

export function toCommentResource(row: CommentRow): z.output<typeof CommentResource> {
  const { text, truncated } = truncateText(row.body);
  return {
    id: row.id,
    brandId: row.brandId,
    connectionId: row.connectionId,
    platform: row.platform,
    externalId: row.externalId,
    parentId: row.parentId,
    parentRemoved: row.parentRemoved,
    authorName: row.authorAnonymizedAt ? null : row.authorDisplayName,
    text,
    textTruncated: truncated,
    postedAt: row.postedAt.toISOString(),
    ingestedAt: row.ingestedAt.toISOString(),
    status: publicStatus(row.platformState, row.hasOpenReviewItem),
    flagged: row.hasOpenReviewItem,
    permalink: row.permalink,
    isOwnAccount: row.isOwnAccount,
  };
}
