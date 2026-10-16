import type {
  BrandDay,
  HiddenCursor,
  HiddenItem,
  HiddenRowState,
  HiddenSource,
  HistoryEntry,
  UnhideAttempt,
} from '@feedbouncer/actions';
import type { ConnectionStatus, Platform } from '@feedbouncer/connectors';

type Iso<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

export type UnhideAttemptDto = Iso<UnhideAttempt>;
export type HistoryEntryDto = Iso<HistoryEntry>;
export type BrandDayDto = Iso<BrandDay>;

/** A row as the page shows it. Comment text and names are for display only: never log them. */
export interface HiddenItemDto {
  hideActionId: string;
  organizationId: string;
  organizationName: string;
  brandId: string;
  brandName: string;
  connectionId: string;
  connectionName: string;
  connectionStatus: ConnectionStatus;
  platform: Platform;
  commentId: string;
  commentBody: string;
  commentState: HiddenItem['commentState'];
  authorName: string | null;
  hiddenAt: string;
  source: HiddenSource;
  reason: string | null;
  lastAttempt: UnhideAttemptDto | null;
  state: HiddenRowState;
  canUnhide: boolean;
  history: HistoryEntryDto[];
}

export interface HiddenPageDto {
  items: HiddenItemDto[];
  next: { before: string; beforeId: string } | null;
  brands: BrandDayDto[];
}

const iso = (d: Date): string => d.toISOString();

export const toBrandDayDto = (b: BrandDay): BrandDayDto => ({ ...b, dayStart: iso(b.dayStart) });

export const toNextDto = (c: HiddenCursor | null): HiddenPageDto['next'] =>
  c && { before: iso(c.hiddenAt), beforeId: c.hideActionId };

/** Run step ids stay server-side. Only people are named in the history. */
export function toHiddenItemDto(item: HiddenItem): HiddenItemDto {
  const { ruleStepId, ...i } = item;
  void ruleStepId;
  return {
    ...i,
    hiddenAt: iso(i.hiddenAt),
    lastAttempt: i.lastAttempt && {
      ...i.lastAttempt,
      createdAt: iso(i.lastAttempt.createdAt),
      completedAt: i.lastAttempt.completedAt && iso(i.lastAttempt.completedAt),
    },
    history: i.history.map((h) => ({
      ...h,
      actorName: h.actorType === 'user' ? h.actorName : null,
      at: iso(h.at),
    })),
  };
}
