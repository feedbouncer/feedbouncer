import { describe, expect, it } from 'vitest';
import { planCycle, TIER, type QueuedAction } from './planner.js';

const OWNER = `UC${'o'.repeat(22)}`;
const MOD = `UC${'m'.repeat(22)}`;
const A = `UC${'a'.repeat(22)}`;
const B = `UC${'b'.repeat(22)}`;
const T0 = Date.parse('2026-10-24T12:00:00Z');

let n = 0;
const q = (
  kind: QueuedAction['kind'],
  o: Partial<QueuedAction> & { at?: number } = {},
): QueuedAction => {
  n += 1;
  const id = String(n).padStart(4, '0');
  const { at, ...rest } = o;
  return {
    actionId: `act-${id}`,
    kind,
    requestedAt: new Date(T0 + (at ?? n) * 1000),
    commentId: `cmt-${id}`,
    commentExternalId: `Ugx${id}comment`,
    parentExternalId: null,
    parentState: null,
    sourceExternalId: 'dQw4w9WgXcQ',
    authorExternalId: A,
    commentState: 'visible',
    ruleId: null,
    ...rest,
  };
};

const opts = (affordableBatches: number) => ({
  affordableBatches,
  ownerChannelId: OWNER,
  protectedAuthorIds: new Set([MOD]),
});

describe('planCycle', () => {
  it('maps tiers', () => {
    expect(TIER).toEqual({ ban_author: 0, delete: 1, hide: 2, unhide: 3 });
  });

  it('orders ban, reject, hold', () => {
    const hold = q('hide', { at: 1, authorExternalId: B });
    const reject = q('delete', { at: 3, authorExternalId: B });
    const ban = q('ban_author', { at: 2 });
    const p = planCycle([hold, reject, ban], opts(2));
    expect(p.batches.map((b) => [b.moderationStatus, b.banAuthor])).toEqual([
      ['rejected', true],
      ['rejected', false],
    ]);
    expect(p.batches.map((b) => b.action)).toEqual(['ban_author', 'delete']);
    expect(p.deferred).toEqual([hold.actionId]);
    expect(p.plannedUnits).toBe(102);
  });

  it('oldest first within tier', () => {
    const deletes = Array.from({ length: 60 }, (_, i) =>
      q('delete', { at: 1000 - i, authorExternalId: B }),
    );
    const p = planCycle(deletes, opts(1));
    const oldest = [...deletes]
      .sort((x, y) => x.requestedAt.getTime() - y.requestedAt.getTime())
      .slice(0, 50)
      .map((d) => d.actionId);
    expect(p.batches).toHaveLength(1);
    expect(p.batches[0]!.items.map((i) => i.actionId)).toEqual(oldest);
    expect(p.deferred.length).toBe(10);
    expect(p.plannedUnits).toBe(51);
  });

  it('breaks requestedAt ties by action id', () => {
    const x = q('delete', { at: 5, actionId: 'act-b' });
    const y = q('delete', { at: 5, actionId: 'act-a' });
    expect(planCycle([x, y], opts(1)).batches[0]!.items.map((i) => i.actionId)).toEqual([
      'act-a',
      'act-b',
    ]);
  });

  it('folds repeat offender rejects into the ban', () => {
    const c1 = q('ban_author', { authorExternalId: A });
    const c2 = q('delete', { authorExternalId: A });
    const c3 = q('delete', { authorExternalId: B });
    const p = planCycle([c1, c2, c3], opts(2));
    expect(p.batches).toHaveLength(2);
    expect(p.batches[0]!.items).toEqual([
      {
        actionId: c1.actionId,
        commentExternalId: c1.commentExternalId,
        sourceExternalId: c1.sourceExternalId,
        folded: false,
      },
      {
        actionId: c2.actionId,
        commentExternalId: c2.commentExternalId,
        sourceExternalId: c2.sourceExternalId,
        folded: true,
      },
    ]);
    expect(p.batches[1]!.items.map((i) => [i.commentExternalId, i.folded])).toEqual([
      [c3.commentExternalId, false],
    ]);
    expect(p.deferred).toEqual([]);
  });

  it('folds only while the ban batch has room', () => {
    const bans = Array.from({ length: 49 }, () => q('ban_author', { authorExternalId: A }));
    const d1 = q('delete', { authorExternalId: A });
    const d2 = q('delete', { authorExternalId: A });
    const p = planCycle([...bans, d1, d2], opts(2));
    expect(p.batches[0]!.items).toHaveLength(50);
    expect(p.batches[0]!.items.at(-1)).toMatchObject({ actionId: d1.actionId, folded: true });
    expect(p.batches[1]!.items.map((i) => [i.actionId, i.folded])).toEqual([[d2.actionId, false]]);
  });

  it('holds are never folded into a ban', () => {
    const ban = q('ban_author', { authorExternalId: A });
    const hold = q('hide', { authorExternalId: A });
    const p = planCycle([ban, hold], opts(2));
    expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([
      [ban.actionId],
      [hold.actionId],
    ]);
    expect(p.batches[1]).toMatchObject({ moderationStatus: 'heldForReview', banAuthor: false });
  });

  it('reply under rejected parent is covered', () => {
    const t = q('delete', { authorExternalId: B });
    const r = q('hide', { parentExternalId: t.commentExternalId });
    const p = planCycle([t, r], opts(2));
    expect(p.settleNow).toEqual([
      { actionId: r.actionId, status: 'noop', code: 'covered_by_parent' },
    ]);
    expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([[t.actionId]]);
  });

  it('reply under a banned parent or an already deleted parent is covered', () => {
    const ban = q('ban_author', { authorExternalId: B });
    const r1 = q('delete', { parentExternalId: ban.commentExternalId });
    const r2 = q('hide', { parentExternalId: 'UgxGoneParent', parentState: 'deleted' });
    const p = planCycle([ban, r1, r2], opts(3));
    expect(p.settleNow).toEqual([
      { actionId: r1.actionId, status: 'noop', code: 'covered_by_parent' },
      { actionId: r2.actionId, status: 'noop', code: 'covered_by_parent' },
    ]);
    expect(p.batches).toHaveLength(1);
  });

  it('never bans the channel owner or a protected author', () => {
    const own = q('ban_author', { authorExternalId: OWNER });
    const mod = q('ban_author', { authorExternalId: MOD });
    const anon = q('ban_author', { authorExternalId: null });
    const ok = q('ban_author', { authorExternalId: A });
    const p = planCycle([own, mod, anon, ok], opts(5));
    expect(p.settleNow).toEqual([
      { actionId: own.actionId, status: 'not_eligible', code: 'author_protected' },
      { actionId: mod.actionId, status: 'not_eligible', code: 'author_protected' },
      { actionId: anon.actionId, status: 'not_eligible', code: 'author_unavailable' },
    ]);
    expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([[ok.actionId]]);
  });

  it('a protected author is still rejected, just not banned', () => {
    const del = q('delete', { authorExternalId: MOD });
    const p = planCycle([del], opts(1));
    expect(p.batches.map((b) => [b.action, b.items[0]!.actionId])).toEqual([
      ['delete', del.actionId],
    ]);
  });

  it("ban on a reply is not covered by its parent's reject", () => {
    const t = q('delete', { authorExternalId: B });
    const ban = q('ban_author', { parentExternalId: t.commentExternalId });
    const p = planCycle([t, ban], opts(2));
    expect(p.settleNow).toEqual([]);
    expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([
      [ban.actionId],
      [t.actionId],
    ]);
  });

  it('affordableBatches 0 defers everything and plans 0 units', () => {
    const ban = q('ban_author', { authorExternalId: A });
    const folded = q('delete', { authorExternalId: A });
    const hold = q('hide', { authorExternalId: B });
    const p = planCycle([ban, folded, hold], opts(0));
    expect(p.batches).toEqual([]);
    expect(p.deferred).toEqual([ban.actionId, folded.actionId, hold.actionId]);
    expect(p.plannedUnits).toBe(0);
  });

  it('rejecting or banning a comment YouTube already holds still writes', () => {
    const rej = q('delete', { commentState: 'hidden', authorExternalId: B });
    const ban = q('ban_author', { commentState: 'hidden' });
    const p = planCycle([rej, ban], opts(5));
    expect(p.settleNow).toEqual([]);
    expect(p.batches.map((b) => b.action)).toEqual(['ban_author', 'delete']);
  });

  it('only a hold, a deleted reject or a published unhide is skipped', () => {
    const hold = q('hide', { commentState: 'hidden' });
    const rej = q('delete', { commentState: 'deleted' });
    const pub = q('unhide', { commentState: 'visible' });
    const unhide = q('unhide', { commentState: 'hidden' });
    const p = planCycle([hold, rej, pub, unhide], opts(5));
    expect(p.settleNow).toEqual([
      { actionId: rej.actionId, status: 'noop', code: 'already_moderated' },
      { actionId: hold.actionId, status: 'noop', code: 'already_moderated' },
      { actionId: pub.actionId, status: 'noop', code: 'already_published' },
    ]);
    expect(p.batches.map((b) => [b.moderationStatus, b.action, b.items[0]!.actionId])).toEqual([
      ['published', 'unhide', unhide.actionId],
    ]);
  });

  it('is deterministic regardless of input order', () => {
    const items = [
      q('hide', { authorExternalId: B }),
      q('ban_author', { authorExternalId: A }),
      q('delete', { authorExternalId: A }),
      q('unhide', { commentState: 'hidden' }),
      q('delete', { authorExternalId: B }),
    ];
    const a = planCycle(items, opts(3));
    const b = planCycle([...items].reverse(), opts(3));
    expect(b).toEqual(a);
    expect(a.deferred).toHaveLength(1);
  });

  it('does not mutate its input', () => {
    const items = Object.freeze([q('hide'), q('delete')]);
    expect(() => planCycle(items, opts(1))).not.toThrow();
  });

  describe('coverage by a parent', () => {
    it('a deferred parent does not cover its reply', () => {
      const ban = q('ban_author', { authorExternalId: A });
      const t = q('delete', { authorExternalId: B });
      const r = q('hide', { authorExternalId: B, parentExternalId: t.commentExternalId });
      const p = planCycle([ban, t, r], opts(1));
      expect(p.settleNow).toEqual([]);
      expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([[ban.actionId]]);
      expect(p.deferred).toEqual([t.actionId, r.actionId]);
    });

    it('a kept parent covers its reply', () => {
      const ban = q('ban_author', { authorExternalId: A });
      const t = q('delete', { authorExternalId: B });
      const r = q('hide', { authorExternalId: B, parentExternalId: t.commentExternalId });
      const p = planCycle([ban, t, r], opts(2));
      expect(p.settleNow).toEqual([
        { actionId: r.actionId, status: 'noop', code: 'covered_by_parent' },
      ]);
      expect(p.batches.map((b) => b.items.map((i) => i.actionId))).toEqual([
        [ban.actionId],
        [t.actionId],
      ]);
      expect(p.deferred).toEqual([]);
      expect(p.plannedUnits).toBe(102);
    });

    it('a reject on a reply is not covered by a parent deferred in the same tier', () => {
      const r = q('delete', { authorExternalId: B, parentExternalId: 'UgxParentLater' });
      const others = Array.from({ length: 49 }, () => q('delete', { authorExternalId: B }));
      const t = q('delete', { authorExternalId: B, commentExternalId: 'UgxParentLater' });
      const p = planCycle([r, ...others, t], opts(1));
      expect(p.settleNow).toEqual([]);
      expect(p.batches[0]!.items.map((i) => i.actionId)).toEqual([
        r.actionId,
        ...others.map((x) => x.actionId),
      ]);
      expect(p.deferred).toEqual([t.actionId]);
    });

    it('rebuilds batches after removing covered replies', () => {
      const r = q('delete', { authorExternalId: B, parentExternalId: 'UgxParentLater' });
      const others = Array.from({ length: 49 }, () => q('delete', { authorExternalId: B }));
      const t = q('delete', { authorExternalId: B, commentExternalId: 'UgxParentLater' });
      const u = q('unhide', { commentState: 'hidden' });
      const p = planCycle([r, ...others, t, u], opts(2));
      expect(p.settleNow).toEqual([
        { actionId: r.actionId, status: 'noop', code: 'covered_by_parent' },
      ]);
      expect(p.batches.map((b) => b.items.length)).toEqual([50, 1]);
      expect(p.batches[0]!.items.at(-1)!.actionId).toBe(t.actionId);
      expect(p.batches[1]!.items[0]!.actionId).toBe(u.actionId);
      expect(p.deferred).toEqual([]);
      expect(p.plannedUnits).toBe(102);
    });

    it('an emptied batch is dropped and frees its slot', () => {
      const t = q('delete', { authorExternalId: B });
      const r = q('hide', { authorExternalId: B, parentExternalId: t.commentExternalId });
      const u = q('unhide', { commentState: 'hidden' });
      const p = planCycle([t, r, u], opts(2));
      expect(p.batches.map((b) => b.action)).toEqual(['delete', 'unhide']);
      expect(p.settleNow.map((s) => [s.actionId, s.code])).toEqual([
        [r.actionId, 'covered_by_parent'],
      ]);
    });
  });

  describe('several actions on one comment', () => {
    it('reject wins over hold on the same comment', () => {
      const hold = q('hide', { at: 1, commentExternalId: 'UgxSameComment1' });
      const del = q('delete', { at: 2, commentExternalId: 'UgxSameComment1' });
      const p = planCycle([hold, del], opts(2));
      expect(p.settleNow).toEqual([
        { actionId: hold.actionId, status: 'noop', code: 'superseded' },
      ]);
      expect(p.batches.map((b) => [b.action, b.items.map((i) => i.actionId)])).toEqual([
        ['delete', [del.actionId]],
      ]);
    });

    it('ban wins over a reject on the same comment, which is not folded twice', () => {
      const ban = q('ban_author', { authorExternalId: A, commentExternalId: 'UgxSameComment2' });
      const del = q('delete', { authorExternalId: A, commentExternalId: 'UgxSameComment2' });
      const p = planCycle([del, ban], opts(2));
      expect(p.settleNow).toEqual([{ actionId: del.actionId, status: 'noop', code: 'superseded' }]);
      expect(p.batches).toHaveLength(1);
      expect(p.batches[0]!.items).toEqual([
        {
          actionId: ban.actionId,
          commentExternalId: 'UgxSameComment2',
          sourceExternalId: ban.sourceExternalId,
          folded: false,
        },
      ]);
    });

    it('hold vs publish on one comment keeps the lower tier whatever the input order', () => {
      const hold = q('hide', { at: 2, commentExternalId: 'UgxSameComment3' });
      const pub = q('unhide', { at: 1, commentExternalId: 'UgxSameComment3' });
      const p = planCycle([pub, hold], opts(2));
      expect(planCycle([hold, pub], opts(2))).toEqual(p);
      expect(p.batches.map((b) => [b.action, b.items.map((i) => i.actionId)])).toEqual([
        ['hide', [hold.actionId]],
      ]);
      expect(p.settleNow.map((s) => s.actionId)).toEqual([pub.actionId]);
    });

    it('two holds on one comment: the older wins', () => {
      const h1 = q('hide', { at: 1, commentExternalId: 'UgxSameComment4' });
      const h2 = q('hide', { at: 2, commentExternalId: 'UgxSameComment4' });
      const p = planCycle([h2, h1], opts(1));
      expect(p.batches[0]!.items.map((i) => i.actionId)).toEqual([h1.actionId]);
      expect(p.settleNow).toEqual([{ actionId: h2.actionId, status: 'noop', code: 'superseded' }]);
    });

    it('no batch ever holds the same comment twice', () => {
      const items = [
        q('ban_author', { authorExternalId: A, commentExternalId: 'UgxDup' }),
        q('delete', { authorExternalId: A, commentExternalId: 'UgxDup' }),
        q('delete', { authorExternalId: A }),
        q('hide', { commentExternalId: 'UgxDup' }),
      ];
      for (const b of planCycle(items, opts(5)).batches) {
        const ids = b.items.map((i) => i.commentExternalId);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  });
});
