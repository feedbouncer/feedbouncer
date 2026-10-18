import { describe, expect, it } from 'vitest';
import { reviewTimeToHide, timeToHide } from './timing.js';
import { item } from './fixtures.js';
import type { EvalItem } from '../schema.js';

const br = {
  deliveryMs: 1000,
  ingestQueueMs: 2000,
  processingMs: 3000,
  hideQueueMs: 4000,
  hideCallMs: 5000,
};
const timed = (totalMs: number, over: Partial<EvalItem> = {}, breakdown: typeof br | null = br) =>
  item({ timing: { totalMs, retried: false, breakdown }, ...over });

describe('timeToHide', () => {
  it('summarises 40 webhook items', () => {
    const items = Array.from({ length: 40 }, (_, i) => timed((i + 1) * 1000));
    const t = timeToHide(items, 'automatic').byChannel.webhook.total;
    expect(t).toMatchObject({ status: 'ok', n: 40, p50: 20000, p95: 38000, max: 40000 });
  });

  it('queueWait = ingestQueue + hideQueue per item', () => {
    const s = timeToHide([timed(15000)], 'automatic').byChannel.webhook.segments;
    expect(s.queueWait).toMatchObject({ p50: 6000 });
    expect(s.delivery).toMatchObject({ p50: 1000 });
  });

  it('backfill and noop excluded and counted', () => {
    const r = timeToHide(
      [timed(1000, { channel: 'backfill' }), timed(1000, { removalNoop: true }), timed(1000)],
      'automatic',
    );
    expect(r).toMatchObject({ backfillExcluded: 1, noopExcluded: 1 });
    expect(r.byChannel.webhook.total).toMatchObject({ n: 1 });
  });

  it('negative delivery kept and counted; invalid and retried counted', () => {
    const r = timeToHide(
      [
        timed(5000, {}, { ...br, deliveryMs: -2000 }),
        item({ timing: null }),
        item({ timing: { totalMs: 1, retried: true, breakdown: null } }),
      ],
      'automatic',
    );
    expect(r.negativeDelivery).toBe(1);
    expect(r.timingInvalid).toBe(1);
    expect(r.retried).toBe(1);
    expect(r.byChannel.webhook.total).toMatchObject({ n: 2 });
    expect(r.byChannel.webhook.segments.delivery).toMatchObject({ n: 1, p50: -2000 });
  });

  it('poll and webhook reported separately', () => {
    const r = timeToHide(
      [timed(1000), timed(2000, { channel: 'poll' }), timed(3000, { channel: 'poll' })],
      'automatic',
    );
    expect(r.byChannel.webhook.total.n).toBe(1);
    expect(r.byChannel.poll.total.n).toBe(2);
  });

  it('breakdownN counts only items with breakdown', () => {
    const r = timeToHide([timed(1000), timed(2000, {}, null)], 'automatic');
    expect(r.byChannel.webhook.breakdownN).toBe(1);
    expect(r.byChannel.webhook.total.n).toBe(2);
  });
});

describe('reviewTimeToHide', () => {
  it('splits human wait', () => {
    const rv = (status: string, humanWaitMs: number | null) => ({
      suggestionStatus: status,
      humanWaitMs,
    });
    const r = reviewTimeToHide([
      timed(3_600_000, { cohort: 'review', review: rv('approved', 1_800_000) }),
      timed(1000, { review: rv('approved', 1) }),
      item({ cohort: 'review', outcome: 'not_hidden', review: rv('pending', null) }),
    ]);
    expect(r.includingHumanWait).toMatchObject({ n: 1, p50: 3_600_000 });
    expect(r.humanWait).toMatchObject({ p50: 1_800_000 });
    expect(r.excludingHumanWait).toMatchObject({ p50: 1_800_000 });
    expect(r.suggestionsByStatus).toEqual({ approved: 1, pending: 1 });
  });
});
