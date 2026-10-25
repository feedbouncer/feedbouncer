export type YouTubeBudgetMode = 'disabled' | 'paused' | 'exhausted' | 'read_only' | 'active';

export interface YouTubeBudgetStatus {
  settings: { dailyBudgetUnits: number; dryRun: boolean; protectedAuthorIds: string[] };
  limits: { maxBudgetUnits: number; projectQuotaUnits: number };
  today: {
    pacificDay: string;
    /** ISO time of the next Pacific midnight. */
    resetAt: string;
    mode: YouTubeBudgetMode;
    budgetUnits: number;
    spentUnits: number;
    readsSpentUnits: number;
    writesSpentUnits: number;
    readReserveUnits: number;
    remainingUnits: number;
    simulatedUnits: number;
    /** ISO time the project-wide quota pause ends, while it lasts. */
    pausedUntil: string | null;
  };
  backlog: {
    ban: number;
    reject: number;
    hold: number;
    publish: number;
    skippedOverflowToday: number;
  };
  nextReadAt: string | null;
  lastErrorCode: string | null;
}

export const DRY_RUN_BADGE = 'Dry run: actions are logged with their quota cost, not applied';
export const PROTECTED_HELP =
  'Channel moderators: FeedBouncer will never ban these channels. YouTube does not let apps read your moderator list.';

export const waitingCount = (b: YouTubeBudgetStatus['backlog']): number =>
  b.ban + b.reject + b.hold + b.publish;

/** The mode banner, with each time passed through `fmt`; null while the connection is active. */
export function bannerText(s: YouTubeBudgetStatus, fmt: (iso: string) => string): string | null {
  const n = waitingCount(s.backlog);
  switch (s.today.mode) {
    case 'paused':
      return `YouTube's daily quota for this FeedBouncer installation is used up. Moderation resumes at ${fmt(s.today.pausedUntil ?? s.today.resetAt)}. ${n} actions are waiting.`;
    case 'read_only':
      return `Budget too low for moderation actions. New comments are still checked; ${n} actions are waiting.`;
    case 'exhausted':
      return `Today's budget is spent. ${n} actions wait until ${fmt(s.today.resetAt)}.`;
    case 'disabled':
      return 'Budget is 0. FeedBouncer is not calling YouTube for this channel.';
    case 'active':
      return null;
  }
}
