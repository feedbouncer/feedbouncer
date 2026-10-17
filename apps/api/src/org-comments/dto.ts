import type {
  AccountHealth,
  AdOption,
  FilterOptions,
  VisibleComment,
  VisibleCommentCursor,
} from '@feedbouncer/actions';

type Iso<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

/** Bodies and names are for display only: never log them. */
export type VisibleCommentDto = Iso<VisibleComment>;
export type AccountHealthDto = Iso<AccountHealth>;
export type FilterOptionsDto = FilterOptions;
export type AdOptionDto = AdOption;

export interface CommentsPageDto {
  items: VisibleCommentDto[];
  next: { before: string; beforeId: string } | null;
  total: number;
  applied: {
    platform: string | null;
    ad: string | null;
    category: string | null;
    status: string | null;
  };
}

export interface CommentFiltersDto {
  options: FilterOptionsDto;
  accounts: AccountHealthDto[];
  lastSyncedAt: string | null;
  canManageConnections: boolean;
}

const iso = (d: Date): string => d.toISOString();

export const toCommentDto = (c: VisibleComment): VisibleCommentDto => ({
  ...c,
  postedAt: iso(c.postedAt),
});

export const toAccountDto = (a: AccountHealth): AccountHealthDto => ({
  ...a,
  lastSyncedAt: a.lastSyncedAt && iso(a.lastSyncedAt),
});

export const toNextDto = (c: VisibleCommentCursor | null): CommentsPageDto['next'] =>
  c && { before: iso(c.postedAt), beforeId: c.id };
