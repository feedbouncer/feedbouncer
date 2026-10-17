import { describe, expect, it } from 'vitest';
import type { AccountHealth, VisibleComment } from '@feedbouncer/actions';
import { toAccountDto, toCommentDto, toNextDto } from './dto.js';

const at = new Date('2026-10-16T10:00:00.000Z');

describe('org comments dto', () => {
  it('serializes dates to ISO', () => {
    const c = toCommentDto(
      { id: 'c1', postedAt: at, ads: [], done: null, replies: [] } as unknown as VisibleComment,
      { available: false, reason: 'not_permitted' },
    );
    expect(c.postedAt).toBe('2026-10-16T10:00:00.000Z');
    const a = toAccountDto({ connectionId: 'x', lastSyncedAt: at } as unknown as AccountHealth);
    expect(a.lastSyncedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(
      toAccountDto({ lastSyncedAt: null } as unknown as AccountHealth).lastSyncedAt,
    ).toBeNull();
  });

  it('adds reply availability, drops the reply target and serializes done and reply dates', () => {
    const c = toCommentDto(
      {
        id: 'c1',
        postedAt: at,
        done: { at, byName: 'Dana' },
        tags: [{ id: 't1', name: 'Urgent' }],
        replies: [
          {
            id: 'r1',
            text: 'thanks',
            status: 'pending',
            actorType: 'user',
            authorName: 'Dana',
            createdAt: at,
            completedAt: null,
          },
        ],
        replyCount: 1,
        replyTarget: { connectionStatus: 'active' },
      } as unknown as VisibleComment,
      { available: true, maxChars: 2200 },
    );
    expect(c).not.toHaveProperty('replyTarget');
    expect(c.reply).toEqual({ available: true, maxChars: 2200 });
    expect(c.done).toEqual({ at: '2026-10-16T10:00:00.000Z', byName: 'Dana' });
    expect(c.replies[0]).toMatchObject({
      createdAt: '2026-10-16T10:00:00.000Z',
      completedAt: null,
    });
    expect(c.tags).toEqual([{ id: 't1', name: 'Urgent' }]);
    expect(c.replyCount).toBe(1);
  });

  it('next is the query pair for the next request, null without a cursor', () => {
    expect(toNextDto({ postedAt: at, id: 'c1' })).toEqual({
      before: '2026-10-16T10:00:00.000Z',
      beforeId: 'c1',
    });
    expect(toNextDto(null)).toBeNull();
  });
});
