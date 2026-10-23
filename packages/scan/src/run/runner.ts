// Runs one scan: read the Page's recent ad comments, classify them in memory and
// persist only the aggregated result. Tokens live only in memory; comment text,
// commenter names and tokens are never logged.
import { mapProviderError, prepareInput, type PreparedInput } from '@feedbouncer/ai';
import {
  DEFAULT_THRESHOLDS,
  describeClassification,
  scoreClassification,
  type ClassifierProvider,
  type RawClassification,
} from '@feedbouncer/classifier';
import {
  ConnectorError,
  type RateBudget,
  type RateLimitPolicy,
  type SafeHttp,
} from '@feedbouncer/connectors';
import { open, type KeyProvider } from '@feedbouncer/secrets';
import type { Logger, Secret } from '@feedbouncer/service-runtime';
import { ResultBuilder, type ScannedComment } from '../aggregate.js';
import { bucketOf } from '../bucket.js';
import type { ScanFailure, ScanResultV1 } from '../contract.js';
import type { ScanSettings } from '../config.js';
import { discoverRecentAdPosts, type AdPost } from '../graph/ads.js';
import { readPostComments } from '../graph/comments.js';
import { grantedScopes, resolvePage, type ScanGraph } from '../graph/pages.js';
import {
  CLASSIFY_RESERVE_MS,
  FETCH_DEADLINE_MS,
  JOB_DEADLINE_MS,
  MAX_COMMENTS_PER_AD,
  MIN_RELIABLE_SAMPLE,
  WINDOW_DAYS,
} from '../limits.js';
import { maskAuthor, normalizeText } from '../mask.js';
import type { ClaimedScan, PgScanStore } from '../pg/store.js';
import { SCAN_OPTIONAL_SCOPES } from '../scopes.js';
import { tagComment } from '../tags.js';
import { scanTokenCtx } from './transport.js';

const DAY_MS = 86_400_000;
const MAX_WAIT_MS = 20_000;
const MAX_WAITS = 3;
const CLASSIFY_CONCURRENCY = 8;
const RETRY_DELAY_MS = 250;
const RETRYABLE = new Set(['timeout', 'rate_limited', 'unavailable']);

export interface ScanMetrics {
  finished(m: {
    status: 'completed' | 'failed';
    reason: ScanFailure | null;
    durationSec: number;
    commentsScanned: number | null;
  }): void;
}

export interface ScanRunnerDeps {
  store: PgScanStore;
  keys: KeyProvider;
  graph: ScanGraph;
  classifier: ClassifierProvider;
  languages: readonly string[];
  budget: RateBudget;
  /** The rate policy the Facebook connector declares in its capabilities. */
  facebookRatePolicy: RateLimitPolicy;
  settings: ScanSettings;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Logger;
  metrics: ScanMetrics;
}

export type ScanRunOutcome =
  | { status: 'completed' }
  | { status: 'failed'; reason: ScanFailure }
  | { status: 'skipped' };

class ScanFailed extends Error {
  constructor(
    readonly reason: ScanFailure,
    readonly errorCode: string | null = null,
  ) {
    super(`scan failed: ${reason}`);
  }
}

/** A comment as held in memory: the author is already masked, the name is gone. */
type Fetched = Pick<
  ScannedComment,
  'adOrdinal' | 'hidden' | 'text' | 'normText' | 'authorLabel' | 'tags'
>;
type Classified = Pick<ScannedComment, 'bucket' | 'category' | 'score' | 'reason'> & {
  providerError: boolean;
};
/** A text never classified because the classification budget ran out. */
const TIME_LIMITED = 'time_limited';
type Outcome = Classified | typeof TIME_LIMITED;

/** Wall-clock budget for one phase, on the runner's clock, with a matching abort signal. */
interface Budget {
  deadlineMs: number;
  signal: AbortSignal;
}

export async function runScan(d: ScanRunnerDeps, scanId: string): Promise<ScanRunOutcome> {
  const startedMs = d.nowMs();
  const claimed = await d.store.claim(scanId, new Date(startedMs));
  if (!claimed) {
    d.log.info('scan.skipped', { scanId });
    return { status: 'skipped' };
  }
  const { attempt } = claimed;
  const durationSec = () => (d.nowMs() - startedMs) / 1000;
  let result: ScanResultV1;
  try {
    result = await scan(d, scanId, claimed);
  } catch (err) {
    const failed = err instanceof ScanFailed ? err : null;
    const reason = failed?.reason ?? 'internal';
    d.log.warn('scan.failed', {
      scanId,
      attempt,
      reason,
      error: err instanceof Error ? err.name : 'NonError',
      errorCode: failed?.errorCode ?? (err instanceof ConnectorError ? err.code : null),
    });
    if (
      !(await settle(d, scanId, attempt, () =>
        d.store.fail(scanId, attempt, reason, new Date(d.nowMs())),
      ))
    ) {
      return { status: 'skipped' };
    }
    d.metrics.finished({
      status: 'failed',
      reason,
      durationSec: durationSec(),
      commentsScanned: null,
    });
    return { status: 'failed', reason };
  }
  if (
    !(await settle(d, scanId, attempt, () =>
      d.store.complete(scanId, attempt, result, new Date(d.nowMs())),
    ))
  ) {
    // Deleted by the visitor, or superseded by a newer attempt.
    d.log.info('scan.discarded', { scanId, attempt });
    return { status: 'skipped' };
  }
  const { postsScanned, commentsScanned } = result.totals;
  d.log.info('scan.completed', { scanId, attempt, postsScanned, commentsScanned });
  d.metrics.finished({
    status: 'completed',
    reason: null,
    durationSec: durationSec(),
    commentsScanned,
  });
  return { status: 'completed' };
}

/**
 * Writes the final state. If that write throws, one best-effort fail('internal') tries to
 * clear the token before the error is rethrown for the queue to retry.
 */
async function settle(
  d: ScanRunnerDeps,
  scanId: string,
  attempt: number,
  write: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await write();
  } catch (err) {
    d.log.error('scan.store_failed', {
      scanId,
      error: err instanceof Error ? err.name : 'NonError',
    });
    await d.store.fail(scanId, attempt, 'internal', new Date(d.nowMs())).catch((again: unknown) => {
      d.log.error('scan.store_failed', {
        scanId,
        error: again instanceof Error ? again.name : 'NonError',
      });
    });
    throw err;
  }
}

async function scan(
  d: ScanRunnerDeps,
  scanId: string,
  claimed: ClaimedScan,
): Promise<ScanResultV1> {
  const jobDeadlineMs = d.nowMs() + JOB_DEADLINE_MS;
  const signal = AbortSignal.timeout(JOB_DEADLINE_MS);
  const g = d.graph;
  const userToken = await open(d.keys, claimed.token.blob, scanTokenCtx(scanId));
  const pageId = claimed.pageExternalId;
  const page = await platform(() => resolvePage(g, userToken, pageId, signal));
  if (!page.canModerate) throw new ScanFailed('insufficient_page_role');
  const scopes = await platform(() => grantedScopes(g, userToken, signal));
  const igUserId =
    g.ig && SCAN_OPTIONAL_SCOPES.every((s) => scopes.includes(s)) ? page.igUserId : null;
  const posts = await platform(() =>
    discoverRecentAdPosts(g, userToken, { pageId, igUserId }, signal),
  );
  const builder = new ResultBuilder(
    posts.map((p) => ({
      ordinal: p.ordinal,
      platform: p.platform,
      label: p.label,
      adCount: p.adIds.length,
    })),
    d.settings.maxComments,
  );
  if (igUserId === null) builder.notice('instagram_not_included');
  const fetched = await fetchComments(d, builder, {
    pageId,
    pageName: claimed.pageName,
    pageToken: page.pageToken,
    posts,
    signal,
    // Fetching never eats into the share of the job reserved for classification.
    budgetMs: Math.min(FETCH_DEADLINE_MS, jobDeadlineMs - CLASSIFY_RESERVE_MS - d.nowMs()),
  });
  // Classification has its own budget: whatever is left of the job, not the job signal.
  const classifyMs = Math.max(0, jobDeadlineMs - d.nowMs());
  await classifyInto(d, builder, fetched, {
    deadlineMs: d.nowMs() + classifyMs,
    signal: AbortSignal.timeout(classifyMs),
  });
  return builder.build();
}

function failureOf(e: ConnectorError): ScanFailed | null {
  const code = e.code;
  if (e.kind === 'auth_expired') return new ScanFailed('access_revoked', code);
  if (e.kind === 'permanent' && code === 'permission_denied') {
    return new ScanFailed('missing_permissions', code);
  }
  if (e.kind === 'rate_limited') return new ScanFailed('rate_limited', code);
  if (e.kind === 'transient') return new ScanFailed('platform_unavailable', code);
  return null;
}

async function platform<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw (e instanceof ConnectorError && failureOf(e)) || e;
  }
}

/**
 * Every comment page first takes a point from a per-Page budget at `background` priority,
 * whose window allows fewer points than other priorities. It shares no counters with paid connections.
 */
function budgeted(d: ScanRunnerDeps, pageId: string): SafeHttp {
  const inner = d.graph.http;
  return {
    async request(req, signal) {
      const grant = await d.budget.acquire('facebook', pageId, d.facebookRatePolicy, 'background');
      if (!grant.granted) {
        throw new ConnectorError('rate_limited', 'scan_budget_exhausted', {
          retryAfterMs: grant.retryAfterMs,
        });
      }
      return inner.request(req, signal);
    },
  };
}

async function fetchComments(
  d: ScanRunnerDeps,
  builder: ResultBuilder,
  t: {
    pageId: string;
    pageName: string;
    pageToken: Secret;
    posts: AdPost[];
    signal: AbortSignal;
    budgetMs: number;
  },
): Promise<Fetched[]> {
  const startMs = d.nowMs();
  const budgetMs = Math.max(0, t.budgetMs);
  const timeLeft = () => budgetMs - (d.nowMs() - startMs);
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(budgetMs)]);
  const g = { ...d.graph, http: budgeted(d, t.pageId) };
  const sinceMs = startMs - WINDOW_DAYS * DAY_MS;
  const seen = new Set<string>();
  const out: Fetched[] = [];
  let visible = 0;
  let waits = 0;
  let stopped: ScanFailed | null = null;

  posts: for (const post of t.posts) {
    for (;;) {
      if (timeLeft() <= 0) {
        builder.notice('sampled_time_limit');
        break posts;
      }
      try {
        const comments = readPostComments(
          g,
          t.pageToken,
          post,
          sinceMs,
          MAX_COMMENTS_PER_AD,
          signal,
        );
        for await (const c of comments) {
          // A retried post re-reads from the start; Graph pages can also overlap.
          if (c.platformState === 'deleted' || seen.has(c.externalId)) continue;
          seen.add(c.externalId);
          const hidden = c.platformState === 'hidden';
          const name = c.author?.displayName ?? null;
          out.push({
            adOrdinal: post.ordinal,
            hidden,
            text: c.body,
            normText: normalizeText(c.body),
            authorLabel: maskAuthor(name),
            tags: tagComment(c.body, name, t.pageName),
          });
          if (!hidden && ++visible >= d.settings.maxComments) {
            builder.notice('sampled_comment_cap');
            break posts;
          }
          if (timeLeft() <= 0) {
            builder.notice('sampled_time_limit');
            break posts;
          }
        }
        continue posts;
      } catch (e) {
        if (signal.aborted && !t.signal.aborted) {
          builder.notice('sampled_time_limit');
          break posts;
        }
        if (!(e instanceof ConnectorError)) throw e;
        if (e.kind === 'not_found') continue posts;
        const wait = e.kind === 'rate_limited' ? e.retryAfterMs : null;
        if (wait !== null && wait <= MAX_WAIT_MS && waits < MAX_WAITS && wait < timeLeft()) {
          waits++;
          await d.sleep(wait);
          continue;
        }
        const failure = failureOf(e);
        if (!failure) throw e;
        if (e.kind !== 'rate_limited' && e.kind !== 'transient') throw failure;
        stopped = failure;
        break posts;
      }
    }
  }
  if (stopped) {
    if (visible < MIN_RELIABLE_SAMPLE) throw stopped;
    builder.notice(
      stopped.reason === 'rate_limited' ? 'partial_rate_limited' : 'partial_platform_unavailable',
    );
  }
  return out;
}

const UNCLASSIFIED: Classified = {
  ...bucketOf({ kind: 'unclassified' }),
  reason: '',
  providerError: false,
};

const timeUp = (b: Budget, now: number) => b.signal.aborted || now >= b.deadlineMs;

/**
 * One provider call, retried once after 250 ms on a retryable error; null when it still
 * fails, TIME_LIMITED when the classification budget ran out first.
 */
async function callProvider(
  d: ScanRunnerDeps,
  input: PreparedInput,
  b: Budget,
): Promise<RawClassification | null | typeof TIME_LIMITED> {
  for (let attempt = 0; ; attempt++) {
    if (timeUp(b, d.nowMs())) return TIME_LIMITED;
    try {
      return await d.classifier.classify(input, b.signal);
    } catch (e) {
      if (timeUp(b, d.nowMs())) return TIME_LIMITED;
      if (attempt > 0 || !RETRYABLE.has(mapProviderError(e).code)) return null;
      if (d.nowMs() + RETRY_DELAY_MS >= b.deadlineMs) return TIME_LIMITED;
      await d.sleep(RETRY_DELAY_MS);
    }
  }
}

async function classifyText(d: ScanRunnerDeps, text: string, b: Budget): Promise<Outcome> {
  const input = prepareInput(text);
  if (input.empty || input.lowSignal) return UNCLASSIFIED;
  const raw = await callProvider(d, input, b);
  if (raw === TIME_LIMITED) return TIME_LIMITED;
  if (raw === null) return { ...UNCLASSIFIED, providerError: true };
  const s = scoreClassification(raw, input, DEFAULT_THRESHOLDS, d.languages);
  return {
    ...bucketOf({
      kind: 'scored',
      input,
      scores: s.scores,
      languageSupported: s.languageSupported,
    }),
    reason: describeClassification(s.verdict, { truncated: input.truncated }),
    providerError: false,
  };
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Classifies each distinct visible text once; hidden comments are never sent. Texts left
 * unclassified because time ran out are dropped from the sample (with sampled_time_limit),
 * never counted as provider errors; too few classified comments left fails with timeout.
 */
async function classifyInto(
  d: ScanRunnerDeps,
  builder: ResultBuilder,
  fetched: Fetched[],
  b: Budget,
): Promise<void> {
  const texts = new Map<string, string>();
  for (const c of fetched) if (!c.hidden && !texts.has(c.normText)) texts.set(c.normText, c.text);
  const outcomes = new Map<string, Outcome>();
  await eachLimit([...texts], CLASSIFY_CONCURRENCY, async ([norm, text]) => {
    outcomes.set(norm, await classifyText(d, text, b));
  });
  let assessed = 0;
  let providerErrors = 0;
  let classified = 0;
  let timeLimited = false;
  for (const c of fetched) {
    const outcome = c.hidden ? UNCLASSIFIED : outcomes.get(c.normText)!;
    if (outcome === TIME_LIMITED) {
      timeLimited = true;
      continue;
    }
    const { providerError, ...verdict } = outcome;
    if (!c.hidden) {
      assessed++;
      if (providerError) providerErrors++;
      if (verdict.bucket !== 'unclassified') classified++;
    }
    builder.add({ ...c, ...verdict });
  }
  if (providerErrors * 2 > assessed) throw new ScanFailed('classifier_unavailable');
  if (timeLimited) {
    if (classified < MIN_RELIABLE_SAMPLE) throw new ScanFailed('timeout');
    builder.notice('sampled_time_limit');
  }
}
