import type {
  AccountHealth,
  AdOption,
  CommentReply,
  FilterOptions,
  Queue,
  Tag,
  VisibleComment,
  VisibleCommentCursor,
} from '@feedbouncer/actions';
import type { ActionStatus } from '@feedbouncer/comments';
import type { ReplyAvailability } from './reply-availability.js';

type Iso<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

export type CommentReplyDto = Iso<CommentReply>;

/**
 * Bodies, names and reply text are for display only: never log them. The reply target is internal
 * (it decides `reply`), so it is not sent.
 */
export type VisibleCommentDto = Omit<Iso<VisibleComment>, 'replyTarget' | 'done' | 'replies'> & {
  done: { at: string; byName: string | null } | null;
  replies: CommentReplyDto[];
  reply: ReplyAvailability;
};
export type AccountHealthDto = Iso<AccountHealth>;
export type FilterOptionsDto = FilterOptions;
export type AdOptionDto = AdOption;
export type TagDto = Iso<Tag>;

/** A public reply on a comment. The text is for display only: never log it. */
export interface ReplyDto {
  id: string;
  status: ActionStatus;
  outcomeCode: string | null;
  text: string;
  authorName: string | null;
  actorType: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CommentsPageDto {
  items: VisibleCommentDto[];
  next: { before: string; beforeId: string } | null;
  total: number;
  applied: {
    platform: string | null;
    ad: string | null;
    category: string | null;
    status: string | null;
    queue: Queue;
    tags: string[];
  };
}

export interface CommentFiltersDto {
  options: FilterOptionsDto;
  accounts: AccountHealthDto[];
  lastSyncedAt: string | null;
  canManageConnections: boolean;
  permissions: { reply: boolean; triage: boolean; manageTags: boolean };
}

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => d && iso(d);

export function toCommentDto(c: VisibleComment, reply: ReplyAvailability): VisibleCommentDto {
  const shown: Partial<VisibleComment> = { ...c };
  delete shown.replyTarget;
  return {
    ...(shown as Omit<VisibleComment, 'replyTarget'>),
    postedAt: iso(c.postedAt),
    done: c.done && { at: iso(c.done.at), byName: c.done.byName },
    replies: c.replies.map((r) => ({
      ...r,
      createdAt: iso(r.createdAt),
      completedAt: isoOrNull(r.completedAt),
    })),
    reply,
  };
}

export const toAccountDto = (a: AccountHealth): AccountHealthDto => ({
  ...a,
  lastSyncedAt: a.lastSyncedAt && iso(a.lastSyncedAt),
});

export const toTagDto = (t: Tag): TagDto => ({ ...t, createdAt: iso(t.createdAt) });

export const toNextDto = (c: VisibleCommentCursor | null): CommentsPageDto['next'] =>
  c && { before: iso(c.postedAt), beforeId: c.id };
