import { describe, expect, it } from 'vitest';
import type { AccountHealth, VisibleComment } from '@feedbouncer/actions';
import { toAccountDto, toCommentDto, toNextDto } from './dto.js';

const at = new Date('2026-10-16T10:00:00.000Z');

describe('org comments dto', () => {
  it('serializes dates to ISO', () => {
    const c = toCommentDto({ id: 'c1', postedAt: at, ads: [] } as unknown as VisibleComment);
    expect(c.postedAt).toBe('2026-10-16T10:00:00.000Z');
    const a = toAccountDto({ connectionId: 'x', lastSyncedAt: at } as unknown as AccountHealth);
    expect(a.lastSyncedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(
      toAccountDto({ lastSyncedAt: null } as unknown as AccountHealth).lastSyncedAt,
    ).toBeNull();
  });

  it('next is the query pair for the next request, null without a cursor', () => {
    expect(toNextDto({ postedAt: at, id: 'c1' })).toEqual({
      before: '2026-10-16T10:00:00.000Z',
      beforeId: 'c1',
    });
    expect(toNextDto(null)).toBeNull();
  });
});
