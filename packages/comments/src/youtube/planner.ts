// The pure YouTube write planner: turns the queued backlog into one cycle's
// write batches. Every batch costs the same (BATCH_UNITS), so strict tier order
// is kept by keeping the first `affordableBatches` batches. Deterministic: the
// input order never matters, and nothing is read from the clock or the network.
import type { ModerationAction, PlatformState } from '@feedbouncer/connectors';
import { BATCH_UNITS, MAX_BATCH } from '@feedbouncer/connector-youtube';

export type QueuedKind = 'ban_author' | 'delete' | 'hide' | 'unhide';

/** Lower goes first: reject + ban, reject, hold, publish. */
export const TIER: Record<QueuedKind, 0 | 1 | 2 | 3> = {
  ban_author: 0,
  delete: 1,
  hide: 2,
  unhide: 3,
};

export interface QueuedAction {
  actionId: string;
  kind: QueuedKind;
  requestedAt: Date;
  commentId: string;
  commentExternalId: string;
  parentExternalId: string | null;
  /** The stored state of the parent comment, when it is stored; null for top-level comments. */
  parentState?: PlatformState | null;
  sourceExternalId: string;
  authorExternalId: string | null;
  commentState: PlatformState;
  ruleId: string | null;
}

export interface PlannedItem {
  actionId: string;
  commentExternalId: string;
  sourceExternalId: string;
  /** A queued reject folded into a ban batch for the same author. */
  folded: boolean;
}

export interface PlannedBatch {
  moderationStatus: 'heldForReview' | 'published' | 'rejected';
  banAuthor: boolean;
  action: ModerationAction;
  items: PlannedItem[];
}

export interface SettleNow {
  actionId: string;
  status: 'noop' | 'not_eligible';
  code: string;
}

export interface CyclePlan {
  batches: PlannedBatch[];
  settleNow: SettleNow[];
  /** Action ids left queued for a later cycle, in plan order. */
  deferred: string[];
  plannedUnits: number;
}

export interface PlanOptions {
  affordableBatches: number;
  /** The connected channel: never banned. */
  ownerChannelId: string;
  protectedAuthorIds: ReadonlySet<string>;
}

const SHAPE: Record<QueuedKind, Pick<PlannedBatch, 'moderationStatus' | 'banAuthor'>> = {
  ban_author: { moderationStatus: 'rejected', banAuthor: true },
  delete: { moderationStatus: 'rejected', banAuthor: false },
  hide: { moderationStatus: 'heldForReview', banAuthor: false },
  unhide: { moderationStatus: 'published', banAuthor: false },
};

const byPriority = (a: QueuedAction, b: QueuedAction): number =>
  TIER[a.kind] - TIER[b.kind] ||
  a.requestedAt.getTime() - b.requestedAt.getTime() ||
  (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0);

const item = (a: QueuedAction, folded: boolean): PlannedItem => ({
  actionId: a.actionId,
  commentExternalId: a.commentExternalId,
  sourceExternalId: a.sourceExternalId,
  folded,
});

/** Outcomes known without any call, or null when the action needs a write. */
function settleRule(a: QueuedAction, o: PlanOptions): SettleNow | null {
  const noop = (code: string): SettleNow => ({ actionId: a.actionId, status: 'noop', code });
  if (a.kind === 'ban_author') {
    if (a.authorExternalId === null)
      return { actionId: a.actionId, status: 'not_eligible', code: 'author_unavailable' };
    if (a.authorExternalId === o.ownerChannelId || o.protectedAuthorIds.has(a.authorExternalId))
      return { actionId: a.actionId, status: 'not_eligible', code: 'author_protected' };
  }
  if (a.kind === 'unhide') return a.commentState === 'visible' ? noop('already_published') : null;
  // Only a hold is redundant on a held comment; rejecting or banning still needs the write.
  const redundant = a.kind === 'hide' ? a.commentState !== 'visible' : a.commentState === 'deleted';
  return redundant ? noop('already_moderated') : null;
}

const chunk = (kind: QueuedKind, xs: readonly QueuedAction[]): PlannedBatch[] => {
  const out: PlannedBatch[] = [];
  for (let i = 0; i < xs.length; i += MAX_BATCH)
    out.push({
      ...SHAPE[kind],
      action: kind,
      items: xs.slice(i, i + MAX_BATCH).map((a) => item(a, false)),
    });
  return out;
};

export function planCycle(q: readonly QueuedAction[], o: PlanOptions): CyclePlan {
  const settleNow: SettleNow[] = [];
  const byTier: QueuedAction[][] = [[], [], [], []];
  const sorted = [...q].sort(byPriority);
  // 1 + 2: settle what is already known, then sort the rest. Of several actions
  // on one comment only the first by priority is sent, so they never undo each
  // other and no batch names a comment twice.
  const claimed = new Set<string>();
  for (const a of sorted) {
    const s = settleRule(a, o);
    if (s) settleNow.push(s);
    else if (claimed.has(a.commentExternalId))
      settleNow.push({ actionId: a.actionId, status: 'noop', code: 'superseded' });
    else {
      claimed.add(a.commentExternalId);
      byTier[TIER[a.kind]]!.push(a);
    }
  }
  const [bans, rejects, holds, publishes] = byTier as [
    QueuedAction[],
    QueuedAction[],
    QueuedAction[],
    QueuedAction[],
  ];

  // 3: ban batches, each with its authors' queued rejects folded in while there is room.
  const folded = new Set<string>();
  const banBatches = chunk('ban_author', bans).map((b, i) => {
    const authors = new Set(
      bans.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH).map((a) => a.authorExternalId!),
    );
    for (const r of rejects) {
      if (b.items.length >= MAX_BATCH) break;
      if (folded.has(r.actionId) || r.authorExternalId === null) continue;
      if (!authors.has(r.authorExternalId)) continue;
      b.items.push(item(r, true));
      folded.add(r.actionId);
    }
    return b;
  });
  const unfoldedRejects = rejects.filter((r) => !folded.has(r.actionId));

  // 4–6: a reject or hold on a reply needs no write of its own when its parent is
  // already deleted, or is rejected by a batch this cycle keeps. A parent that is
  // only deferred covers nothing: its reject may never happen. Removing covered
  // replies only moves later items into earlier batches, so the kept set only
  // grows; repeat until it is stable.
  const keep = Math.max(0, Math.floor(o.affordableBatches));
  const coverable = [...unfoldedRejects, ...holds].filter((a) => a.parentExternalId !== null);
  const covered = new Set(
    coverable.filter((a) => a.parentState === 'deleted').map((a) => a.actionId),
  );
  const open = (xs: QueuedAction[]) => xs.filter((a) => !covered.has(a.actionId));
  let all: PlannedBatch[];
  for (;;) {
    // 5: the other tiers, oldest first.
    all = [
      ...banBatches,
      ...chunk('delete', open(unfoldedRejects)),
      ...chunk('hide', open(holds)),
      ...chunk('unhide', publishes),
    ];
    const rejectedParents = new Set(
      all
        .slice(0, keep)
        .filter((b) => b.moderationStatus === 'rejected')
        .flatMap((b) => b.items.map((i) => i.commentExternalId)),
    );
    const more = coverable.filter(
      (a) => !covered.has(a.actionId) && rejectedParents.has(a.parentExternalId!),
    );
    if (more.length === 0) break;
    for (const a of more) covered.add(a.actionId);
  }
  for (const a of sorted)
    if (covered.has(a.actionId))
      settleNow.push({ actionId: a.actionId, status: 'noop', code: 'covered_by_parent' });

  // 6 + 7: keep what the budget affords, in tier order.
  const batches = all.slice(0, keep);
  const deferred = all.slice(keep).flatMap((b) => b.items.map((i) => i.actionId));
  return { batches, settleNow, deferred, plannedUnits: batches.length * BATCH_UNITS };
}
