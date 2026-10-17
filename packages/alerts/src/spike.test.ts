import { describe, expect, it } from 'vitest';
import {
  evaluateSpike,
  nextSpikeState,
  type SpikeInput,
  type SpikeState,
  type SpikeVerdict,
} from './spike.js';

const now = new Date('2026-10-17T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

const base: SpikeInput = {
  sensitivity: 'medium',
  minCount: 10,
  windowNegatives: 10,
  windowTotal: 200,
  baselineNegatives: 672,
  baselineTotal: 3360,
  baselineHours: 336,
  firstLiveAt: daysAgo(30),
  now,
};
const input = (o: Partial<SpikeInput>): SpikeInput => ({ ...base, ...o });

describe('evaluateSpike', () => {
  it('fires on volume', () => {
    expect(evaluateSpike(base)).toMatchObject({
      fire: true,
      trigger: 'volume',
      volumeThreshold: 6,
    });
  });

  it('is below_min under the minimum count', () => {
    expect(evaluateSpike(input({ windowNegatives: 9 }))).toEqual({
      fire: false,
      reason: 'below_min',
    });
  });

  it('stays within a high baseline', () => {
    const v = evaluateSpike(
      input({
        baselineNegatives: 1680,
        baselineTotal: 16800,
        windowNegatives: 12,
      }),
    );
    expect(v).toEqual({ fire: false, reason: 'within_baseline' });
  });

  const shareBase = {
    baselineNegatives: 6720,
    baselineTotal: 13440,
    windowNegatives: 12,
  };

  it('fires on share when volume is not met', () => {
    const v = evaluateSpike(input({ ...shareBase, windowTotal: 13 }));
    expect(v).toMatchObject({
      fire: true,
      trigger: 'share',
      volumeThreshold: 60,
      shareThreshold: 0.9,
    });
  });

  it('does not fire below the share threshold', () => {
    const v = evaluateSpike(input({ ...shareBase, windowTotal: 14 }));
    expect(v).toEqual({ fire: false, reason: 'within_baseline' });
  });

  it('scales with sensitivity', () => {
    const fires = (s: SpikeInput['sensitivity'], o: Partial<SpikeInput>) =>
      evaluateSpike(input({ sensitivity: s, windowNegatives: 12, ...o })).fire;
    expect(fires('high', {})).toBe(true);
    expect(fires('medium', {})).toBe(true);
    expect(fires('low', {})).toBe(true);
    expect(fires('low', { windowNegatives: 10 })).toBe(true);
    expect(fires('low', { baselineNegatives: 1008, baselineTotal: 10080 })).toBe(false);
  });

  it('learns until a week of live data', () => {
    const learning = { fire: false, reason: 'learning' };
    expect(evaluateSpike(input({ firstLiveAt: daysAgo(6) }))).toEqual(learning);
    expect(evaluateSpike(input({ firstLiveAt: null }))).toEqual(learning);
  });

  it('uses the default rate without baseline hours', () => {
    expect(
      evaluateSpike(input({ baselineHours: 0, baselineNegatives: 0, baselineTotal: 0 })),
    ).toMatchObject({ fire: true, expectedPerHour: 2 });
  });

  it('does not divide by an empty window', () => {
    expect(evaluateSpike(input({ windowTotal: 0, windowNegatives: 10 }))).toMatchObject({
      fire: true,
      trigger: 'volume',
      share: 0,
    });
  });
});

describe('nextSpikeState', () => {
  const idle: SpikeState = {
    episodeId: null,
    cooldownUntil: null,
    triggerCount: null,
    escalated: false,
  };
  const fire = evaluateSpike(base) as Extract<SpikeVerdict, { fire: true }>;
  const quiet: SpikeVerdict = { fire: false, reason: 'within_baseline' };
  const step = (s: SpikeState, v: SpikeVerdict, n: number, at = now) =>
    nextSpikeState(s, v, n, at, 360, () => 'ep-new');
  const active: SpikeState = {
    episodeId: 'ep-1',
    cooldownUntil: new Date(now.getTime() + 3_600_000),
    triggerCount: 10,
    escalated: false,
  };

  it('starts an episode when firing outside a cooldown', () => {
    const r = step(idle, fire, 10);
    expect(r.emit).toBe('negative_spike');
    expect(r.state).toEqual({
      episodeId: 'ep-new',
      cooldownUntil: new Date(now.getTime() + 360 * 60_000),
      triggerCount: 10,
      escalated: false,
    });
  });

  it('stays silent inside a cooldown below the escalation count', () => {
    expect(step(active, fire, 19)).toEqual({ state: active, emit: null });
  });

  it('escalates once inside a cooldown', () => {
    const first = step(active, fire, 20);
    expect(first.emit).toBe('spike_escalation');
    expect(first.state).toEqual({ ...active, escalated: true });
    expect(step(first.state, fire, 50)).toEqual({
      state: first.state,
      emit: null,
    });
  });

  it('starts a new episode after the cooldown', () => {
    const later = new Date(active.cooldownUntil!.getTime());
    const r = step({ ...active, escalated: true }, fire, 10, later);
    expect(r.emit).toBe('negative_spike');
    expect(r.state.episodeId).toBe('ep-new');
    expect(r.state.escalated).toBe(false);
  });

  it('leaves state alone when not firing inside a cooldown', () => {
    expect(step(active, quiet, 3)).toEqual({ state: active, emit: null });
  });
});
