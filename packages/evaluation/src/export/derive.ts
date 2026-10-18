// Turns the stored facts of one comment into one pseudonymous EvalItem. Pure: no I/O.
import { createHmac } from 'node:crypto';
import { bodySha256 } from '@feedbouncer/rules';
import type { EvalItem } from '../schema.js';

export type ActionFact = {
  id: string;
  kind: string;
  status: string;
  outcomeCode: string | null;
  actorType: string;
  ruleId: string | null;
  requestKey: string;
  createdAt: Date;
  completedAt: Date | null;
};

export type LedgerFact = {
  createdAt: Date;
  firstClaimedAt: Date | null;
  failures: number;
  crashes: number;
  deferrals: number;
};

export type ClassificationFact = {
  createdAt: Date;
  status: string;
  unclassifiedReason: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  scoresReused: boolean;
  ruleDecided: boolean;
  language: string | null;
  reviewMode: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  retried: boolean;
};

export type PolicyEvalFact = {
  createdAt: Date;
  status: string;
  failureCode: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  reviewMode: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  retried: boolean;
};

export type DecisionFact = {
  outcome: string;
  mode: string;
  actorType: string;
  category: string | null;
  ruleId: string | null;
  classificationId: string | null;
  reversal: boolean;
};

export type SuggestionFact = {
  id: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  sourceType: string | null;
};

export type CommentFacts = {
  commentId: string;
  bodyNow: string;
  platformState: 'visible' | 'hidden' | 'deleted';
  postedAt: Date;
  ingestedAt: Date;
  origin: 'live' | 'backfill';
  platform: 'facebook' | 'instagram';
  actions: ActionFact[];
  ingestLedger: LedgerFact | null;
  /** Keyed by moderation_action id. */
  execLedgers: ReadonlyMap<string, LedgerFact>;
  ruleEvals: { createdAt: Date; sha: string; status: string; reviewMode: boolean }[];
  classifications: ClassificationFact[];
  policyEvals: PolicyEvalFact[];
  decisions: DecisionFact[];
  suggestion: SuggestionFact | null;
  ruleKindById: ReadonlyMap<string, string>;
};

const AUTOMATION_ACTORS = new Set(['rule', 'classifier', 'policy', 'system']);
const REMOVAL_KINDS = new Set(['hide', 'delete']);
/** Codes recorded before any provider call was made. */
const NO_CALL_CODES = new Set(['disabled', 'queue_timeout']);
const SLUG = /^[a-z_]+$/;
const MODEL_MAX = 200;

/** 'i_' + the first 16 hex chars of HMAC-SHA256(salt, commentId). */
export function pseudonymiser(salt: Buffer): (commentId: string) => string {
  const key = Buffer.from(salt);
  return (commentId) =>
    `i_${createHmac('sha256', key).update(commentId, 'utf8').digest('hex').slice(0, 16)}`;
}

const byTime = (a: ActionFact, b: ActionFact) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Done by FeedBouncer: automation, or a person approving a review-mode suggestion. */
const byFeedBouncer = (a: ActionFact) =>
  AUTOMATION_ACTORS.has(a.actorType) || a.requestKey.startsWith('suggestion:');

/** The earliest FeedBouncer hide/delete that took effect (or found the comment already hidden). */
export function countedRemoval(actions: readonly ActionFact[]): ActionFact | null {
  return (
    [...actions]
      .sort(byTime)
      .find(
        (a) =>
          REMOVAL_KINDS.has(a.kind) &&
          byFeedBouncer(a) &&
          (a.status === 'applied' || (a.status === 'noop' && a.outcomeCode === 'already_hidden')),
      ) ?? null
  );
}

/** The suggestion behind the counted removal (request key `suggestion:<id>:hide`), else the latest one. */
export function pickSuggestion(
  suggestions: readonly SuggestionFact[],
  actions: readonly ActionFact[],
): SuggestionFact | null {
  const key = countedRemoval(actions)?.requestKey.split(':');
  if (key?.[0] === 'suggestion') {
    const own = suggestions.find((s) => s.id === key[1]);
    if (own) return own;
  }
  return (
    [...suggestions].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0] ?? null
  );
}

function channelOf(f: CommentFacts): { channel: EvalItem['channel']; receivedAt: Date } {
  if (f.origin === 'backfill') return { channel: 'backfill', receivedAt: f.ingestedAt };
  if (f.ingestLedger && f.ingestLedger.createdAt.getTime() <= f.ingestedAt.getTime())
    return { channel: 'webhook', receivedAt: f.ingestLedger.createdAt };
  return { channel: 'poll', receivedAt: f.ingestedAt };
}

function timingOf(
  f: CommentFacts,
  removal: ActionFact,
  channel: EvalItem['channel'],
  receivedAt: Date,
): EvalItem['timing'] {
  if (removal.status !== 'applied' || !removal.completedAt) return null;
  const ms = (a: Date, b: Date) => a.getTime() - b.getTime();
  const totalMs = ms(removal.completedAt, f.postedAt);
  if (totalMs < 0) return null;
  const exec = f.execLedgers.get(removal.id) ?? null;
  const retried = exec !== null && exec.failures + exec.crashes + exec.deferrals > 0;

  let breakdown: NonNullable<EvalItem['timing']>['breakdown'] = null;
  const ingestClaimed = channel === 'webhook' ? (f.ingestLedger?.firstClaimedAt ?? null) : null;
  const ingestOk = channel !== 'webhook' || ingestClaimed !== null;
  if (exec?.firstClaimedAt && ingestOk) {
    const processingFrom = ingestClaimed ?? receivedAt;
    breakdown = {
      deliveryMs: ms(receivedAt, f.postedAt),
      ingestQueueMs: ingestClaimed ? ms(ingestClaimed, receivedAt) : 0,
      processingMs: ms(removal.createdAt, processingFrom),
      hideQueueMs: ms(exec.firstClaimedAt, removal.createdAt),
      hideCallMs: ms(removal.completedAt, exec.firstClaimedAt),
    };
  }
  return { totalMs, retried, breakdown };
}

function deciderOf(f: CommentFacts, removal: ActionFact): string | null {
  if (removal.requestKey.startsWith('suggestion:')) {
    const t = f.suggestion?.sourceType;
    return t === 'rule' || t === 'classifier' || t === 'policy' ? `suggestion:${t}` : null;
  }
  switch (removal.actorType) {
    case 'rule': {
      const kind = removal.ruleId ? f.ruleKindById.get(removal.ruleId) : undefined;
      return kind && SLUG.test(kind) ? `rule:${kind}` : 'rule:unknown';
    }
    case 'classifier': {
      // request_key 'clf:<classificationId>' links the action to its decision and category.
      const classificationId = removal.requestKey.split(':')[1];
      const d = f.decisions.find(
        (x) => x.actorType === 'classifier' && x.classificationId === classificationId,
      );
      return d?.category && SLUG.test(d.category) ? `classifier:${d.category}` : 'classifier';
    }
    case 'policy':
      return 'policy';
    case 'system':
      return 'system';
    default:
      return null;
  }
}

function modelId(provider: string | null, model: string | null): string {
  if (!provider || !model) return 'unknown';
  return `${provider}:${model}`.slice(0, MODEL_MAX);
}

function modelCallsOf(f: CommentFacts): EvalItem['modelCalls'] {
  const calls: EvalItem['modelCalls'] = [];
  const usage = (x: ClassificationFact | PolicyEvalFact) => ({
    inputTokens: x.inputTokens,
    outputTokens: x.outputTokens,
    cacheReadTokens: x.cacheReadTokens,
    retried: x.retried,
  });
  for (const c of [...f.classifications].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )) {
    const called =
      (c.status === 'classified' && !c.scoresReused && c.provider !== 'builtin') ||
      (c.status === 'unclassified' && !NO_CALL_CODES.has(c.unclassifiedReason ?? ''));
    if (called)
      calls.push({ stage: 'classifier', model: modelId(c.provider, c.model), ...usage(c) });
  }
  for (const p of [...f.policyEvals].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )) {
    const called =
      (p.status === 'evaluated' && p.provider !== 'builtin') ||
      (p.status === 'failed' && !NO_CALL_CODES.has(p.failureCode ?? ''));
    if (called) calls.push({ stage: 'policy', model: modelId(p.provider, p.model), ...usage(p) });
  }
  return calls;
}

function languageOf(f: CommentFacts): string {
  const latest = [...f.classifications]
    .filter((c) => c.language !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return latest?.language ?? 'und';
}

export function deriveItem(
  f: CommentFacts,
  pseudonym: (commentId: string) => string,
): EvalItem | 'author_deleted' {
  const actions = [...f.actions].sort(byTime);
  const appliedRemoval = actions.some(
    (a) => REMOVAL_KINDS.has(a.kind) && byFeedBouncer(a) && a.status === 'applied',
  );
  if (f.platformState === 'deleted' && !appliedRemoval) return 'author_deleted';

  const removal = countedRemoval(actions);
  const hideFailed =
    !removal &&
    actions.some((a) => REMOVAL_KINDS.has(a.kind) && byFeedBouncer(a) && a.status === 'failed');
  const { channel, receivedAt } = channelOf(f);

  let restored = false;
  let selfReversed = false;
  let judgedVersionAvailable = true;
  if (removal) {
    const since = (removal.completedAt ?? removal.createdAt).getTime();
    const after = actions.filter((a) => a.createdAt.getTime() >= since && a.kind === 'unhide');
    const userRestore = after.some(
      (a) =>
        a.actorType === 'user' &&
        (a.status === 'applied' || (a.status === 'noop' && a.outcomeCode === 'already_visible')),
    );
    const anyAppliedUnhide = after.some((a) => a.status === 'applied');
    restored = userRestore || (f.platformState === 'visible' && !anyAppliedUnhide);
    selfReversed = after.some((a) => a.status === 'applied' && AUTOMATION_ACTORS.has(a.actorType));

    const judged = [...f.ruleEvals]
      .filter((r) => r.createdAt.getTime() <= removal.createdAt.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    judgedVersionAvailable = judged !== undefined && judged.sha === bodySha256(f.bodyNow);
  }

  const review =
    f.ruleEvals.some((r) => r.reviewMode) ||
    f.classifications.some((c) => c.reviewMode) ||
    f.policyEvals.some((p) => p.reviewMode);

  return {
    item: pseudonym(f.commentId),
    cohort: review ? 'review' : 'automatic',
    channel,
    platform: f.platform,
    language: languageOf(f),
    judgedVersionAvailable,
    ruleDecided:
      f.ruleEvals.some((r) => r.status === 'decided') ||
      f.classifications.some((c) => c.ruleDecided),
    outcome: removal ? 'hidden' : hideFailed ? 'hide_failed' : 'not_hidden',
    removalKind: removal ? (removal.kind as 'hide' | 'delete') : null,
    removalNoop: removal?.status === 'noop',
    restored,
    selfReversed,
    decider: removal ? deciderOf(f, removal) : null,
    caughtByDecision: f.decisions.some(
      (d) =>
        (d.outcome === 'hide' || d.outcome === 'remove') &&
        d.mode === 'enforce' &&
        AUTOMATION_ACTORS.has(d.actorType) &&
        d.actorType !== 'system' &&
        !d.reversal,
    ),
    review: f.suggestion
      ? {
          suggestionStatus: f.suggestion.status,
          humanWaitMs: f.suggestion.decidedAt
            ? f.suggestion.decidedAt.getTime() - f.suggestion.createdAt.getTime()
            : null,
        }
      : null,
    timing: removal ? timingOf(f, removal, channel, receivedAt) : null,
    modelCalls: modelCallsOf(f),
  };
}
