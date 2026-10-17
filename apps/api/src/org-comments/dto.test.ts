import { describe, expect, it } from 'vitest';
import type { AccountHealth, VisibleComment } from '@feedbouncer/actions';
import { ListQuery } from './org-comments.controller.js';
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

describe('ListQuery deep-link filters', () => {
  const BRAND = '3f9a1c52-8d1e-4b6a-9c3f-2a7b5e4d1c60';
  const FROM = '2026-10-10T10:00:00.000Z';
  const ok = (q: Record<string, string>) => ListQuery.safeParse(q).success;

  it('accepts a valid brand, range and signal', () => {
    expect(ok({ brand: BRAND, from: FROM, to: '2026-10-10T11:00:00Z', signal: 'negative' })).toBe(
      true,
    );
    expect(ok({ from: FROM })).toBe(true);
    expect(ok({ from: FROM, to: '2026-11-10T10:00:00.000Z' })).toBe(true);
  });

  it('to <= from → 400; 32-day range → 400; signal=other → 400', () => {
    expect(ok({ from: FROM, to: FROM })).toBe(false);
    expect(ok({ from: FROM, to: '2026-10-10T09:59:59.000Z' })).toBe(false);
    expect(ok({ from: FROM, to: '2026-11-11T10:00:00.000Z' })).toBe(false);
    expect(ok({ signal: 'other' })).toBe(false);
  });

  it('rejects a malformed brand and non-UTC or date-only times', () => {
    expect(ok({ brand: 'abc' })).toBe(false);
    expect(ok({ from: '2026-10-10' })).toBe(false);
    expect(ok({ from: '2026-10-10T10:00:00+02:00' })).toBe(false);
  });
});
