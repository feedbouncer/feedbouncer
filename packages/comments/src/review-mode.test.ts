import { describe, expect, it } from 'vitest';
import {
  GATED_KINDS,
  REVIEW_GRACE_MS,
  REVIEW_WINDOW_MS,
  graceEndsAt,
  reviewModeState,
  type ReviewModeColumns,
} from './review-mode.js';

const START = new Date(Date.UTC(2026, 9, 16, 12, 0, 0));
const ENDS = new Date(START.getTime() + REVIEW_WINDOW_MS);
const window = (o: Partial<ReviewModeColumns> = {}): ReviewModeColumns => ({
  mode: 'on',
  startedAt: START,
  endsAt: ENDS,
  endedAt: null,
  ...o,
});

describe('review mode state', () => {
  it('uses a 168-hour window and a 72-hour grace period', () => {
    expect(REVIEW_WINDOW_MS).toBe(168 * 3_600_000);
    expect(REVIEW_GRACE_MS).toBe(72 * 3_600_000);
  });

  it('legacy is off regardless of dates', () => {
    expect(reviewModeState(window({ mode: 'legacy' }), START)).toBe('off');
    expect(
      reviewModeState(
        { mode: 'legacy', startedAt: null, endsAt: null, endedAt: null },
        new Date(ENDS.getTime() + 1),
      ),
    ).toBe('off');
  });

  it('opted_out is opted_out', () => {
    expect(
      reviewModeState({ mode: 'opted_out', startedAt: null, endsAt: null, endedAt: null }, START),
    ).toBe('opted_out');
  });

  it('on without a start is active', () => {
    expect(
      reviewModeState(
        { mode: 'on', startedAt: null, endsAt: null, endedAt: null },
        new Date(ENDS.getTime() * 2),
      ),
    ).toBe('active');
  });

  it('active until exactly endsAt, ended at endsAt', () => {
    expect(reviewModeState(window(), START)).toBe('active');
    expect(reviewModeState(window(), new Date(ENDS.getTime() - 1))).toBe('active');
    expect(reviewModeState(window(), ENDS)).toBe('ended');
    expect(reviewModeState(window(), new Date(ENDS.getTime() + 1))).toBe('ended');
  });

  it('ended early wins over the window', () => {
    const endedAt = new Date(START.getTime() + 3_600_000);
    expect(reviewModeState(window({ endedAt }), new Date(START.getTime() + 7_200_000))).toBe(
      'ended_early',
    );
    expect(reviewModeState(window({ endedAt }), new Date(ENDS.getTime() + 1))).toBe('ended_early');
  });

  it('graceEndsAt is 72h after endsAt, or after endedAt when ended early', () => {
    expect(graceEndsAt(window())).toEqual(new Date(ENDS.getTime() + REVIEW_GRACE_MS));
    const endedAt = new Date(START.getTime() + 3_600_000);
    expect(graceEndsAt(window({ endedAt }))).toEqual(new Date(endedAt.getTime() + REVIEW_GRACE_MS));
    expect(graceEndsAt({ mode: 'on', startedAt: null, endsAt: null, endedAt: null })).toBeNull();
    expect(graceEndsAt(window({ mode: 'legacy' }))).toBeNull();
    expect(graceEndsAt({ mode: 'opted_out', startedAt: null, endsAt: null, endedAt: null })).toBe(
      null,
    );
  });

  it('gates every kind that acts on the comment or its author, but not the undo kinds', () => {
    expect([...GATED_KINDS].sort()).toEqual(
      ['ban_author', 'delete', 'hide', 'private_reply', 'public_reply'].sort(),
    );
  });
});
