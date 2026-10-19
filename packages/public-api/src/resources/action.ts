import { z } from 'zod';

export const ACTION_KINDS = ['hide', 'unhide', 'public_reply'] as const;
export const ACTION_STATUSES = ['pending', 'applied', 'noop', 'not_eligible', 'failed'] as const;

export const ActionResource = z
  .object({
    id: z.uuid(),
    kind: z.enum(ACTION_KINDS),
    commentId: z.uuid(),
    status: z.enum(ACTION_STATUSES),
    code: z.string().nullable().meta({
      description: 'Why nothing was done or it failed, e.g. `comment_gone`; null otherwise.',
    }),
    platformRef: z.string().nullable().meta({
      description: "The platform's id of the reply once it was posted; null otherwise.",
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Action' });

/** Columns the action query selects. */
export interface ActionRow {
  id: string;
  kind: (typeof ACTION_KINDS)[number];
  commentId: string;
  status: (typeof ACTION_STATUSES)[number];
  outcomeCode: string | null;
  platformRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toActionResource(row: ActionRow): z.output<typeof ActionResource> {
  return {
    id: row.id,
    kind: row.kind,
    commentId: row.commentId,
    status: row.status,
    code: row.outcomeCode,
    platformRef: row.platformRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
