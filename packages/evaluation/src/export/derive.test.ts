import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EvalItem } from '../schema.js';
import {
  deriveItem,
  pickSuggestion,
  pseudonymiser,
  type ActionFact,
  type ClassificationFact,
  type CommentFacts,
  type DecisionFact,
  type LedgerFact,
  type PolicyEvalFact,
} from './derive.js';

const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const BODY = 'buy crypto now';
const pseudo = (id: string) => `i_${sha(id).slice(0, 16)}`;

const action = (o: Partial<ActionFact> & { id: string; createdAt: Date }): ActionFact => ({
  kind: 'hide',
  status: 'applied',
  outcomeCode: null,
  actorType: 'classifier',
  ruleId: null,
  requestKey: `clf:c1`,
  completedAt: o.status === 'pending' ? null : new Date(o.createdAt.getTime() + 2000),
  ...o,
});

const ledger = (o: Partial<LedgerFact> & { createdAt: Date }): LedgerFact => ({
  firstClaimedAt: null,
  failures: 0,
  crashes: 0,
  deferrals: 0,
  ...o,
});

const classification = (o: Partial<ClassificationFact> = {}): ClassificationFact => ({
  createdAt: at(5),
  status: 'classified',
  unclassifiedReason: null,
  provider: 'openai',
  model: 'gpt-x',
  promptVersion: 'v1',
  scoresReused: false,
  ruleDecided: false,
  language: 'en',
  reviewMode: false,
  inputTokens: 90,
  outputTokens: 10,
  cacheReadTokens: 0,
  retried: false,
  ...o,
});

const policyEval = (o: Partial<PolicyEvalFact> = {}): PolicyEvalFact => ({
  createdAt: at(6),
  status: 'evaluated',
  failureCode: null,
  provider: 'openai',
  model: 'gpt-p',
  promptVersion: 'p1',
  reviewMode: false,
  inputTokens: 50,
  outputTokens: 5,
  cacheReadTokens: null,
  retried: false,
  ...o,
});

const decision = (o: Partial<DecisionFact> = {}): DecisionFact => ({
  outcome: 'hide',
  mode: 'enforce',
  actorType: 'classifier',
  category: 'scam_phishing',
  ruleId: null,
  classificationId: 'c1',
  reversal: false,
  ...o,
});

/** Case 1's webhook timeline; other cases override parts of it. */
const facts = (o: Partial<CommentFacts> = {}): CommentFacts => ({
  commentId: 'comment-1',
  bodyNow: BODY,
  platformState: 'hidden',
  postedAt: at(0),
  ingestedAt: at(4),
  origin: 'live',
  platform: 'facebook',
  actions: [action({ id: 'a1', createdAt: at(9), completedAt: at(11) })],
  ingestLedger: ledger({ createdAt: at(2), firstClaimedAt: at(3) }),
  execLedgers: new Map([['a1', ledger({ createdAt: at(9), firstClaimedAt: at(10) })]]),
  ruleEvals: [{ createdAt: at(4), sha: sha(BODY), status: 'no_match', reviewMode: false }],
  classifications: [classification()],
  policyEvals: [],
  decisions: [decision()],
  suggestion: null,
  ruleKindById: new Map(),
  ...o,
});

const derive = (f: CommentFacts): EvalItem => {
  const r = deriveItem(f, pseudo);
  if (r === 'author_deleted') throw new Error('unexpected author_deleted');
  return EvalItem.parse(r);
};

describe('deriveItem', () => {
  it('1. webhook comment hidden by the classifier', () => {
    const it1 = derive(facts());
    expect(it1.item).toBe(pseudo('comment-1'));
    expect(it1.channel).toBe('webhook');
    expect(it1.outcome).toBe('hidden');
    expect(it1.removalKind).toBe('hide');
    expect(it1.cohort).toBe('automatic');
    expect(it1.timing).toEqual({
      totalMs: 11000,
      retried: false,
      breakdown: {
        deliveryMs: 2000,
        ingestQueueMs: 1000,
        processingMs: 6000,
        hideQueueMs: 1000,
        hideCallMs: 1000,
      },
    });
    expect(it1.decider).toBe('classifier:scam_phishing');
    expect(it1.caughtByDecision).toBe(true);
    expect(it1.judgedVersionAvailable).toBe(true);
    expect(it1.language).toBe('en');
    expect(it1.review).toBeNull();
  });

  it('2. polled comment hidden by a link_domain rule', () => {
    const it2 = derive(
      facts({
        ingestedAt: at(240),
        ingestLedger: null,
        actions: [
          action({
            id: 'a1',
            createdAt: at(245),
            completedAt: at(247),
            actorType: 'rule',
            ruleId: 'r1',
            requestKey: 'auto:r1',
          }),
        ],
        execLedgers: new Map([['a1', ledger({ createdAt: at(245), firstClaimedAt: at(246) })]]),
        ruleEvals: [{ createdAt: at(241), sha: sha(BODY), status: 'decided', reviewMode: false }],
        ruleKindById: new Map([['r1', 'link_domain']]),
        decisions: [decision({ actorType: 'rule', ruleId: 'r1', classificationId: null })],
      }),
    );
    expect(it2.channel).toBe('poll');
    expect(it2.timing?.breakdown?.deliveryMs).toBe(240000);
    expect(it2.timing?.breakdown?.ingestQueueMs).toBe(0);
    expect(it2.timing?.breakdown?.processingMs).toBe(5000);
    expect(it2.timing?.totalMs).toBe(247000);
    expect(it2.decider).toBe('rule:link_domain');
    expect(it2.ruleDecided).toBe(true);
  });

  it('a webhook ledger row created after ingestion does not make the comment webhook', () => {
    const it2b = derive(
      facts({ ingestLedger: ledger({ createdAt: at(5), firstClaimedAt: at(6) }) }),
    );
    expect(it2b.channel).toBe('poll');
  });

  it('backfill origin wins over everything', () => {
    expect(derive(facts({ origin: 'backfill' })).channel).toBe('backfill');
  });

  it('3. a failed hide followed by an applied one: hidden, timed from the second', () => {
    const it3 = derive(
      facts({
        actions: [
          action({
            id: 'a0',
            createdAt: at(7),
            status: 'failed',
            outcomeCode: 'retries_exhausted',
            completedAt: at(8),
          }),
          action({ id: 'a1', createdAt: at(9), completedAt: at(11) }),
        ],
      }),
    );
    expect(it3.outcome).toBe('hidden');
    expect(it3.timing?.totalMs).toBe(11000);
    expect(it3.timing?.breakdown?.hideQueueMs).toBe(1000);
  });

  it('4. only a failed hide: hide_failed with no timing', () => {
    const it4 = derive(
      facts({
        platformState: 'visible',
        actions: [
          action({
            id: 'a1',
            createdAt: at(9),
            status: 'failed',
            outcomeCode: 'retries_exhausted',
          }),
        ],
      }),
    );
    expect(it4.outcome).toBe('hide_failed');
    expect(it4.timing).toBeNull();
    expect(it4.removalKind).toBeNull();
    expect(it4.decider).toBeNull();
    expect(it4.judgedVersionAvailable).toBe(true);
  });

  it('5. hidden, unhidden by a user, hidden again: restored, counted once', () => {
    const it5 = derive(
      facts({
        actions: [
          action({ id: 'a1', createdAt: at(9), completedAt: at(11) }),
          action({
            id: 'u1',
            kind: 'unhide',
            actorType: 'user',
            requestKey: 'unhide:x',
            createdAt: at(100),
          }),
          action({ id: 'a2', createdAt: at(200), requestKey: 'clf:c2' }),
        ],
      }),
    );
    expect(it5.restored).toBe(true);
    expect(it5.outcome).toBe('hidden');
    expect(it5.timing?.totalMs).toBe(11000);
    expect(it5.selfReversed).toBe(false);
  });

  it('a user noop already_visible after the hide also counts as restored', () => {
    const it5b = derive(
      facts({
        actions: [
          action({ id: 'a1', createdAt: at(9), completedAt: at(11) }),
          action({
            id: 'u1',
            kind: 'unhide',
            actorType: 'user',
            status: 'noop',
            outcomeCode: 'already_visible',
            requestKey: 'unhide:x',
            createdAt: at(100),
          }),
        ],
      }),
    );
    expect(it5b.restored).toBe(true);
  });

  it('6. visible on the platform with no unhide action: restored in Meta UI', () => {
    expect(derive(facts({ platformState: 'visible' })).restored).toBe(true);
  });

  it('7. classifier self-reversal is not a restore', () => {
    const it7 = derive(
      facts({
        platformState: 'visible',
        actions: [
          action({ id: 'a1', createdAt: at(9), completedAt: at(11) }),
          action({
            id: 'u1',
            kind: 'unhide',
            actorType: 'classifier',
            requestKey: 'clf:x:unhide',
            createdAt: at(60),
          }),
        ],
      }),
    );
    expect(it7.selfReversed).toBe(true);
    expect(it7.restored).toBe(false);
  });

  it('8. deleted with no FeedBouncer removal is author_deleted', () => {
    expect(deriveItem(facts({ platformState: 'deleted', actions: [] }), pseudo)).toBe(
      'author_deleted',
    );
    const manual = facts({
      platformState: 'deleted',
      actions: [action({ id: 'm1', createdAt: at(9), actorType: 'user', requestKey: 'manual:1' })],
    });
    expect(deriveItem(manual, pseudo)).toBe('author_deleted');
  });

  it('8b. deleted after an applied hide is kept as hidden', () => {
    const it8 = derive(facts({ platformState: 'deleted' }));
    expect(it8.outcome).toBe('hidden');
    expect(it8.restored).toBe(false);
  });

  it('a FeedBouncer delete counts as a removal with removalKind delete', () => {
    const it8c = derive(
      facts({
        platformState: 'deleted',
        actions: [action({ id: 'a1', kind: 'delete', createdAt: at(9), completedAt: at(11) })],
      }),
    );
    expect(it8c.outcome).toBe('hidden');
    expect(it8c.removalKind).toBe('delete');
  });

  it('9. edited after the hide: judged version unavailable', () => {
    const it9 = derive(facts({ bodyNow: 'edited text' }));
    expect(it9.judgedVersionAvailable).toBe(false);
  });

  it('9b. the judged version is the latest evaluation at or before the hide', () => {
    const it9b = derive(
      facts({
        bodyNow: 'v2',
        ruleEvals: [
          { createdAt: at(4), sha: sha(BODY), status: 'no_match', reviewMode: false },
          { createdAt: at(50), sha: sha('v2'), status: 'no_match', reviewMode: false },
        ],
      }),
    );
    expect(it9b.judgedVersionAvailable).toBe(false);
  });

  it('10. a manual user hide without a suggestion key is not a FeedBouncer hide', () => {
    const it10 = derive(
      facts({
        actions: [
          action({ id: 'm1', createdAt: at(9), actorType: 'user', requestKey: 'manual:1' }),
        ],
        decisions: [],
      }),
    );
    expect(it10.outcome).toBe('not_hidden');
    expect(it10.timing).toBeNull();
    expect(it10.restored).toBe(false);
    expect(it10.caughtByDecision).toBe(false);
  });

  it('11. review mode suggestion approved after 30 minutes', () => {
    const it11 = derive(
      facts({
        ruleEvals: [{ createdAt: at(4), sha: sha(BODY), status: 'no_match', reviewMode: true }],
        classifications: [classification({ reviewMode: true })],
        decisions: [decision({ mode: 'suggest' })],
        suggestion: {
          id: 's1',
          status: 'approved',
          createdAt: at(10),
          decidedAt: at(10 + 1800),
          sourceType: 'classifier',
        },
        actions: [
          action({
            id: 'a1',
            actorType: 'user',
            requestKey: 'suggestion:s1:hide',
            createdAt: at(1811),
            completedAt: at(1812),
          }),
        ],
        execLedgers: new Map([['a1', ledger({ createdAt: at(1811), firstClaimedAt: at(1811.5) })]]),
      }),
    );
    expect(it11.cohort).toBe('review');
    expect(it11.outcome).toBe('hidden');
    expect(it11.decider).toBe('suggestion:classifier');
    expect(it11.review).toEqual({ suggestionStatus: 'approved', humanWaitMs: 1800000 });
    expect(it11.caughtByDecision).toBe(false);
    expect(it11.timing?.totalMs).toBe(1812000);
  });

  it('picks the suggestion named by the removal key, else the latest', () => {
    const sug = (id: string, sec: number) => ({
      id,
      status: 'x',
      createdAt: at(sec),
      decidedAt: null,
      sourceType: null,
    });
    const list = [sug('s1', 1), sug('s2', 2), sug('s3', 3)];
    const viaKey = [action({ id: 'a1', createdAt: at(5), requestKey: 'suggestion:s2:hide' })];
    expect(pickSuggestion(list, viaKey)?.id).toBe('s2');
    expect(pickSuggestion(list, [])?.id).toBe('s3');
    expect(pickSuggestion([], viaKey)).toBeNull();
  });

  it('12. noop already_hidden counts as hidden without timing', () => {
    const it12 = derive(
      facts({
        actions: [
          action({ id: 'a1', createdAt: at(9), status: 'noop', outcomeCode: 'already_hidden' }),
        ],
      }),
    );
    expect(it12.outcome).toBe('hidden');
    expect(it12.removalNoop).toBe(true);
    expect(it12.timing).toBeNull();
  });

  it('a noop with another outcome code is not a removal', () => {
    const it12b = derive(
      facts({
        platformState: 'visible',
        actions: [action({ id: 'a1', createdAt: at(9), status: 'noop', outcomeCode: 'not_found' })],
      }),
    );
    expect(it12b.outcome).toBe('not_hidden');
  });

  it('13. missing exec ledger: breakdown null, total kept', () => {
    const it13 = derive(facts({ execLedgers: new Map() }));
    expect(it13.timing?.breakdown).toBeNull();
    expect(it13.timing?.totalMs).toBe(11000);
    expect(it13.timing?.retried).toBe(false);
  });

  it('missing ingest claim time: breakdown null', () => {
    const it13b = derive(facts({ ingestLedger: ledger({ createdAt: at(2) }) }));
    expect(it13b.channel).toBe('webhook');
    expect(it13b.timing?.breakdown).toBeNull();
    expect(it13b.timing?.totalMs).toBe(11000);
  });

  it('retried is set from exec ledger counters', () => {
    const it13c = derive(
      facts({
        execLedgers: new Map([
          ['a1', ledger({ createdAt: at(9), firstClaimedAt: at(10), crashes: 1 })],
        ]),
      }),
    );
    expect(it13c.timing?.retried).toBe(true);
  });

  it('14. received 2 s before posted: negative delivery is kept', () => {
    const it14 = derive(
      facts({
        postedAt: at(4),
        ingestLedger: ledger({ createdAt: at(2), firstClaimedAt: at(3) }),
      }),
    );
    expect(it14.timing?.breakdown?.deliveryMs).toBe(-2000);
    expect(it14.timing?.totalMs).toBe(7000);
    const b = it14.timing!.breakdown!;
    expect(b.deliveryMs + b.ingestQueueMs + b.processingMs + b.hideQueueMs + b.hideCallMs).toBe(
      7000,
    );
  });

  it('negative total drops the timing', () => {
    const it14b = derive(facts({ postedAt: at(20), ingestLedger: null, ingestedAt: at(21) }));
    expect(it14b.outcome).toBe('hidden');
    expect(it14b.timing).toBeNull();
  });

  it('15. model calls', () => {
    const it15 = derive(
      facts({
        classifications: [
          classification(),
          classification({ scoresReused: true }),
          classification({ provider: 'builtin', model: 'empty-input' }),
          classification({
            status: 'unclassified',
            unclassifiedReason: 'timeout',
            provider: null,
            model: null,
            language: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
          }),
          classification({
            status: 'unclassified',
            unclassifiedReason: 'queue_timeout',
            provider: null,
            model: null,
            language: null,
          }),
          classification({ status: 'skipped', provider: null, model: null, language: null }),
        ],
        policyEvals: [
          policyEval(),
          policyEval({ provider: 'builtin', model: 'empty-input' }),
          policyEval({ status: 'skipped', provider: null, model: null }),
          policyEval({ status: 'failed', failureCode: 'disabled', provider: null, model: null }),
        ],
      }),
    );
    expect(it15.modelCalls).toEqual([
      {
        stage: 'classifier',
        model: 'openai:gpt-x',
        inputTokens: 90,
        outputTokens: 10,
        cacheReadTokens: 0,
        retried: false,
      },
      {
        stage: 'classifier',
        model: 'unknown',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        retried: false,
      },
      {
        stage: 'policy',
        model: 'openai:gpt-p',
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: null,
        retried: false,
      },
    ]);
  });

  it('carries the retried flag of each model call', () => {
    const calls = derive(
      facts({
        classifications: [classification({ retried: true })],
        policyEvals: [
          policyEval({ status: 'failed', failureCode: 'invalid_output', retried: true }),
        ],
      }),
    ).modelCalls;
    expect(calls.map((c) => c.retried)).toEqual([true, true]);
  });

  it('language falls back to und and cohort is review if any evaluation was in review mode', () => {
    const it16 = derive(
      facts({
        classifications: [],
        policyEvals: [policyEval({ reviewMode: true })],
      }),
    );
    expect(it16.language).toBe('und');
    expect(it16.cohort).toBe('review');
  });

  it('the item carries no comment id, body or other raw identifiers', () => {
    const json = JSON.stringify(derive(facts({ commentId: 'secret-comment-id' })));
    expect(json).not.toContain('secret-comment-id');
    expect(json).not.toContain(BODY);
  });
});

describe('pseudonymiser', () => {
  it('is i_ + 16 hex of HMAC-SHA256 and depends on the salt', () => {
    const a = pseudonymiser(Buffer.alloc(32, 1));
    const b = pseudonymiser(Buffer.alloc(32, 2));
    expect(a('x')).toMatch(/^i_[0-9a-f]{16}$/);
    expect(a('x')).toBe(a('x'));
    expect(a('x')).not.toBe(b('x'));
    expect(a('x')).not.toBe(a('y'));
  });
});
