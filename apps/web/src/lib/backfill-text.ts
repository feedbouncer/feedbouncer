export interface BackfillViewDto {
  status: 'pending' | 'running' | 'completed' | 'failed';
  importedCount: number;
  completedAt: string | null;
  limitedTo: number | null;
  nothingToImport: boolean;
  failureReason: string | null;
  skippedSources: number;
}

// Status line for a connection's recent-comment import; null when there is none.
export function backfillText(
  b: BackfillViewDto | null,
  fmt: (iso: string) => string,
): string | null {
  if (!b) return null;
  switch (b.status) {
    case 'pending':
      return 'Importing recent comments: queued';
    case 'running':
      return `Importing recent comments: ${b.importedCount} so far`;
    case 'completed': {
      const when = b.completedAt ? ` (${fmt(b.completedAt)})` : '';
      const skipped = b.skippedSources > 0 ? `; ${b.skippedSources} posts could not be read` : '';
      if (b.nothingToImport) return `Recent comments: nothing to import${when}${skipped}`;
      const limited = b.limitedTo !== null ? `, limited to most recent ${b.limitedTo}` : '';
      return `Imported ${b.importedCount} recent comments${limited}${when}${skipped}`;
    }
    case 'failed':
      switch (b.failureReason) {
        case 'reconnect_required':
          return `Import stopped after ${b.importedCount} comments: reconnect the account to continue`;
        case 'stalled':
          return 'Import stopped: it will restart the next time you reconnect';
        case 'source_listing_forbidden':
          return 'Import failed: FeedBouncer cannot read this account’s posts';
        default:
          return 'Import failed';
      }
  }
}
