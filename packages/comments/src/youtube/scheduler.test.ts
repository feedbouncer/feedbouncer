import { describe, expect, it, vi } from 'vitest';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { YOUTUBE_CYCLE_JOB } from '../jobs/specs.js';
import { YouTubeCycleScheduler, type YouTubeSchedulerDeps } from './scheduler.js';

const scope = (n: number): ConnectionScope => ({
  organizationId: `00000000-0000-4000-8000-00000000000${n}`,
  brandId: `00000000-0000-4000-9000-00000000000${n}`,
  connectionId: `00000000-0000-4000-a000-00000000000${n}`,
});

function setup(o: Partial<YouTubeSchedulerDeps> = {}) {
  let now = Date.parse('2026-10-24T12:00:10Z');
  const enqueue = vi.fn(async () => ({
    status: 'enqueued' as const,
    ledgerId: 'l',
    jobId: 'j',
  }));
  const warn = vi.fn();
  const state = { dueConnections: vi.fn(async () => [scope(1), scope(2)]) };
  const scheduler = new YouTubeCycleScheduler({
    state,
    producer: { enqueue },
    clock: () => new Date(now),
    tickSec: 60,
    maxConnectionsPerTick: 50,
    log: { warn },
    ...o,
  });
  return { scheduler, enqueue, warn, state, advance: (ms: number) => void (now += ms) };
}

describe('YouTubeCycleScheduler', () => {
  it('enqueues one cycle per due connection per minute slot', async () => {
    const { scheduler, enqueue, state, advance } = setup();
    expect(await scheduler.tick()).toEqual({ enqueued: 2 });
    expect(state.dueConnections).toHaveBeenCalledWith(expect.any(Date), 50);
    const [first] = enqueue.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(first).toMatchObject({
      scope: scope(1),
      platform: 'youtube',
      type: YOUTUBE_CYCLE_JOB.type,
      payload: { connectionId: scope(1).connectionId },
    });
    const keyOf = (i: number) => (enqueue.mock.calls[i]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(keyOf(0)).toBe(`youtube_cycle:${scope(1).connectionId}:${Math.floor(Date.parse('2026-10-24T12:00:10Z') / 60_000)}`);
    expect(keyOf(0)).not.toBe(keyOf(1));

    // Within the slot the key is the same (the job ledger deduplicates); the next slot has a new one.
    await scheduler.tick();
    expect(keyOf(2)).toBe(keyOf(0));
    advance(60_000);
    await scheduler.tick();
    expect(keyOf(4)).not.toBe(keyOf(0));
  });

  it('counts only newly enqueued jobs', async () => {
    const enqueue = vi.fn(async () => ({
      status: 'deduplicated' as const,
      ledgerId: 'l',
      jobId: 'j',
      state: 'queued',
    }));
    const { scheduler } = setup({ producer: { enqueue } as never });
    expect(await scheduler.tick()).toEqual({ enqueued: 0 });
  });

  it('never throws on query failure', async () => {
    const { scheduler, warn } = setup({
      state: { dueConnections: vi.fn().mockRejectedValue(new Error('db down')) },
    });
    await expect(scheduler.tick()).resolves.toEqual({ enqueued: 0 });
    expect(warn).toHaveBeenCalledWith('youtube_scheduler.query_failed', { errorName: 'Error' });
  });

  it('survives one failed enqueue and continues with the next connection', async () => {
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue({ status: 'enqueued', ledgerId: 'l', jobId: 'j' });
    const { scheduler, warn } = setup({ producer: { enqueue } });
    await expect(scheduler.tick()).resolves.toEqual({ enqueued: 1 });
    expect(warn).toHaveBeenCalledWith('youtube_scheduler.enqueue_failed', { errorName: 'Error' });
  });
});
