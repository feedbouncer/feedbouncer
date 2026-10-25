// Column lists and statement helpers shared by the polling stores (TikTok, Threads)
// for the source_poll and connection_poll tables.
export interface SourcePollState {
  highWaterAt: Date | null;
  resumeCursor: string | null;
  resumeBoundary: Date | null;
  resumeNewestAt: Date | null;
  lastPolledAt: Date | null;
  lastFullScanAt: Date | null;
  lastCommentAt: Date | null;
  nextPollAt: Date;
  unavailableSince: Date | null;
  lastErrorCode: string | null;
}

export const SOURCE_COLUMNS = {
  highWaterAt: 'high_water_at',
  resumeCursor: 'resume_cursor',
  resumeBoundary: 'resume_boundary',
  resumeNewestAt: 'resume_newest_at',
  lastPolledAt: 'last_polled_at',
  lastFullScanAt: 'last_full_scan_at',
  lastCommentAt: 'last_comment_at',
  nextPollAt: 'next_poll_at',
  unavailableSince: 'unavailable_since',
  lastErrorCode: 'last_error_code',
} as const satisfies Record<keyof SourcePollState, string>;

export const select = <K extends string>(cols: Record<K, string>, alias: string) =>
  Object.values<string>(cols)
    .map((c) => `${alias}.${c}`)
    .join(', ');

export function fromRow<T>(cols: Record<string, string>, row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, row[c] ?? null])) as T;
}

/** `SET a = $n, …` for the given patch, numbered after `offset` parameters. */
export function assignments<T extends object>(
  cols: Record<keyof T, string>,
  patch: Partial<T>,
  offset: number,
): { sql: string; values: unknown[] } {
  const keys = (Object.keys(patch) as (keyof T)[]).filter((k) => patch[k] !== undefined);
  return {
    sql: keys.map((k, i) => `${cols[k]} = $${offset + i + 1}`).join(', '),
    values: keys.map((k) => patch[k]),
  };
}
