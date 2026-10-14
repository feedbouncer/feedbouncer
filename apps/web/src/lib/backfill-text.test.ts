import { describe, expect, it } from 'vitest';
import { backfillText } from './backfill-text';

const fmt = (iso: string) => iso.slice(0, 10);
const base = {
  importedCount: 0,
  completedAt: null,
  limitedTo: null,
  nothingToImport: false,
  failureReason: null,
  skippedSources: 0,
};
const done = '2026-10-14T10:00:00Z';

describe('backfillText', () => {
  it.each([
    [null, null],
    [{ ...base, status: 'pending' }, 'Importing recent comments: queued'],
    [{ ...base, status: 'running', importedCount: 120 }, 'Importing recent comments: 120 so far'],
    [
      { ...base, status: 'completed', nothingToImport: true, completedAt: done },
      'Recent comments: nothing to import (2026-10-14)',
    ],
    [
      { ...base, status: 'completed', importedCount: 340, completedAt: done },
      'Imported 340 recent comments (2026-10-14)',
    ],
    [
      { ...base, status: 'completed', importedCount: 2000, limitedTo: 2000, completedAt: done },
      'Imported 2000 recent comments, limited to most recent 2000 (2026-10-14)',
    ],
    [
      { ...base, status: 'failed', failureReason: 'reconnect_required', importedCount: 40 },
      'Import stopped after 40 comments: reconnect the account to continue',
    ],
    [
      { ...base, status: 'failed', failureReason: 'stalled' },
      'Import stopped: it will restart the next time you reconnect',
    ],
    [
      { ...base, status: 'failed', failureReason: 'source_listing_forbidden' },
      'Import failed: FeedBouncer cannot read this account’s posts',
    ],
    [{ ...base, status: 'failed', failureReason: 'something_new' }, 'Import failed'],
  ] as const)('%j', (b, expected) => {
    expect(backfillText(b as never, fmt)).toBe(expected);
  });

  it('mentions skipped posts on completion', () => {
    expect(
      backfillText(
        { ...base, status: 'completed', importedCount: 5, skippedSources: 2, completedAt: done },
        fmt,
      ),
    ).toBe('Imported 5 recent comments (2026-10-14); 2 posts could not be read');
  });
});
