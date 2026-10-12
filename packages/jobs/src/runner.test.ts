import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConnectorError } from '@feedbouncer/connectors';
import { createLogger } from '@feedbouncer/service-runtime';
import { JobRegistry } from './definition.js';
import type { ClaimResult, JobLedgerPort, LedgerRow } from './ledger.js';
import { JobMetrics } from './metrics.js';
import { DEFAULT_RETRY_POLICY } from './policy.js';
import { createJobProcessor, type BullJobLike } from './runner.js';

const ID = '11111111-1111-4111-8111-111111111111';
const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: ID,
  scope: { organizationId: 'o', brandId: 'b', connectionId: 'c' },
  platform: 'facebook',
  jobType: 't',
  idempotencyKey: 'a'.repeat(64),
  payload: { ref: 'r' },
  state: 'queued',
  failures: 0,
  crashes: 0,
  deferrals: 0,
  deferredMs: 0,
  replays: 0,
  ...over,
});
function fakeLedger(claim: ClaimResult): JobLedgerPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    claim: vi.fn(async () => claim),
    complete: vi.fn(async () => (calls.push('complete'), true)),
    recordRetry: vi.fn(async () => (calls.push('retry'), true)),
    recordDeferral: vi.fn(async () => (calls.push('defer'), true)),
    deadLetter: vi.fn(
      async (_i: string, _o: string, d: { reason: string; resolution: string | null }) => (
        calls.push(`dlq:${d.reason}:${d.resolution ?? ''}`), true
      ),
    ),
  };
}
function job(over: Partial<BullJobLike> = {}) {
  const moved: number[] = [];
  const j: BullJobLike = {
    id: 'j_x',
    name: 't',
    data: { v: 1, ledgerId: ID },
    moveToDelayed: async (ts: number) => {
      moved.push(ts);
    },
    ...over,
  };
  return { j, moved };
}
function setup(claim: ClaimResult, handle: () => Promise<unknown>) {
  const jobs = new JobRegistry();
  const handler = vi.fn(handle);
  jobs.register({
    type: 't',
    platforms: 'all',
    payload: z.strictObject({ ref: z.string() }),
    externalRef: (p) => p.ref,
    handle: handler as never,
    timeoutMs: 1_000,
  });
  const ledger = fakeLedger(claim);
  const lines: string[] = [];
  const log = createLogger('t', 'debug', (l) => lines.push(l));
  const run = createJobProcessor({
    platform: 'facebook',
    ledger,
    jobs,
    metrics: new JobMetrics(log),
    log,
    workerId: 'w1',
    dlqRetentionMs: 1_000,
    now: () => 1_000_000,
    random: () => 0,
    policyFor: () => ({ ...DEFAULT_RETRY_POLICY, maxAttempts: 3, baseDelayMs: 1_000 }),
  });
  return { run, ledger, handler, lines };
}

describe('createJobProcessor', () => {
  it('uses a distinct lease owner per delivery, the same one for every write', async () => {
    const s = setup({ status: 'claimed', row: row() }, async () => ({ status: 'ok' }));
    await Promise.all([s.run(job().j), s.run(job().j)]);
    const claimed = vi.mocked(s.ledger.claim).mock.calls.map((c) => c[1]);
    const completed = vi.mocked(s.ledger.complete).mock.calls.map((c) => c[1]);
    expect(new Set(claimed).size).toBe(2);
    expect(claimed.every((o) => o.startsWith('w1:facebook:'))).toBe(true);
    expect(completed.sort()).toEqual([...claimed].sort());
  });

  it('runs the handler and records completion', async () => {
    const s = setup({ status: 'claimed', row: row() }, async () => ({ status: 'ok' }));
    expect(await s.run(job().j)).toBe('processed');
    expect(s.ledger.calls).toEqual(['complete']);
  });

  it('acks a redelivery of a settled job without running the handler', async () => {
    const s = setup({ status: 'settled', state: 'completed' }, async () => ({}));
    expect(await s.run(job().j)).toBe('duplicate');
    expect(s.handler).not.toHaveBeenCalled();
  });

  it('delays (not fails) while another worker holds the lease', async () => {
    const s = setup({ status: 'busy', retryInMs: 5_000 }, async () => ({}));
    const { j, moved } = job();
    await expect(s.run(j)).rejects.toBeInstanceOf(DelayedError);
    expect(moved).toEqual([1_005_000]);
  });

  it('retries a transient failure with backoff', async () => {
    const s = setup({ status: 'claimed', row: row() }, async () => {
      throw new ConnectorError('transient', 'upstream_5xx');
    });
    const { j, moved } = job();
    await expect(s.run(j)).rejects.toBeInstanceOf(DelayedError);
    expect(s.ledger.calls).toEqual(['retry']);
    expect(moved).toEqual([1_000_500]);
  });

  it('defers a rate-limit by the hint without recording a failure', async () => {
    const s = setup({ status: 'claimed', row: row({ failures: 2 }) }, async () => {
      throw new ConnectorError('rate_limited', 'throttled', { retryAfterMs: 7_000 });
    });
    const { j, moved } = job();
    await expect(s.run(j)).rejects.toBeInstanceOf(DelayedError);
    expect(s.ledger.calls).toEqual(['defer']);
    expect(moved[0]! - 1_000_000).toBeGreaterThanOrEqual(7_000);
  });

  it.each([
    [new ConnectorError('permanent', 'invalid_request'), 'dlq:non_retryable:'],
    [
      new ConnectorError('auth_expired', 'reauthorization_required', { reauthorize: true }),
      'dlq:needs_reconnection:',
    ],
  ])('dead-letters %s without retry', async (err, call) => {
    const s = setup({ status: 'claimed', row: row() }, async () => {
      throw err;
    });
    await expect(s.run(job().j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.ledger.calls).toEqual([call]);
  });

  it('dead-letters after the attempt cap', async () => {
    const s = setup({ status: 'claimed', row: row({ failures: 2 }) }, async () => {
      throw new Error('boom');
    });
    await expect(s.run(job().j)).rejects.toThrow('dead_lettered: retries_exhausted');
  });

  it('dead-letters a poison job (crashes) before running it', async () => {
    const s = setup({ status: 'claimed', row: row({ failures: 1, crashes: 2 }) }, async () => ({}));
    await expect(s.run(job().j)).rejects.toThrow('dead_lettered: stall_limit_exceeded');
    expect(s.handler).not.toHaveBeenCalled();
  });

  it('refuses jobs whose ledger row belongs to another queue', async () => {
    const s = setup({ status: 'claimed', row: row({ platform: 'youtube' }) }, async () => ({}));
    await expect(s.run(job().j)).rejects.toThrow('dead_lettered: invalid_job');
    expect(s.handler).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ v: 2, ledgerId: ID }],
    [{ v: 1, ledgerId: 'nope' }],
    [{ v: 1, ledgerId: ID, extra: 1 }],
  ])('drops jobs with malformed data %o', async (data) => {
    const s = setup({ status: 'claimed', row: row() }, async () => ({}));
    await expect(s.run(job({ data }).j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.ledger.claim).not.toHaveBeenCalled();
  });

  it('dead-letters a payload that no longer matches the schema', async () => {
    const s = setup({ status: 'claimed', row: row({ payload: { other: 1 } }) }, async () => ({}));
    await expect(s.run(job().j)).rejects.toThrow('dead_lettered: invalid_job');
  });

  it('resolves a replayed job whose target is gone', async () => {
    const s = setup({ status: 'claimed', row: row({ replays: 1 }) }, async () => {
      throw new ConnectorError('not_found', 'comment_missing');
    });
    await expect(s.run(job().j)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.ledger.calls).toEqual(['dlq:non_retryable:target_gone']);
  });

  it('parks a handler that ignores its signal and keeps its lease', async () => {
    const s = setup({ status: 'claimed', row: row() }, () => new Promise(() => {}));
    const { j, moved } = job();
    await expect(s.run(j)).rejects.toBeInstanceOf(DelayedError);
    expect(moved).toHaveLength(1);
    expect(s.ledger.calls).toEqual([]);
  }, 5_000);

  it('records the retry only once the timed-out handler has settled', async () => {
    let finish!: () => void;
    const s = setup(
      { status: 'claimed', row: row() },
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await expect(s.run(job().j)).rejects.toBeInstanceOf(DelayedError);
    expect(s.ledger.calls).toEqual([]);
    finish();
    await vi.waitFor(() => expect(s.ledger.calls).toEqual(['retry']));
  }, 5_000);

  it('never logs a foreign error message', async () => {
    const s = setup({ status: 'claimed', row: row() }, async () => {
      throw new Error('GET https://x/?access_token=LEAKME');
    });
    await expect(s.run(job().j)).rejects.toBeInstanceOf(DelayedError);
    expect(s.lines.join('\n')).not.toContain('LEAKME');
  });
});
