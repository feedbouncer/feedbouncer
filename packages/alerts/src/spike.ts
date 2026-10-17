import {
  DEFAULT_BASELINE_PER_HOUR,
  ESCALATION_FACTOR,
  LEARNING_DAYS,
  SENSITIVITY_MULTIPLIER,
  SHARE_CEILING,
  SHARE_FLOOR,
} from './constants.js';

export type Sensitivity = 'low' | 'medium' | 'high';

export interface SpikeInput {
  sensitivity: Sensitivity;
  minCount: number;
  windowNegatives: number;
  windowTotal: number;
  baselineNegatives: number;
  baselineTotal: number;
  baselineHours: number;
  firstLiveAt: Date | null;
  now: Date;
}

export type SpikeVerdict =
  | { fire: false; reason: 'learning' | 'below_min' | 'within_baseline' }
  | {
      fire: true;
      trigger: 'volume' | 'share';
      expectedPerHour: number;
      volumeThreshold: number;
      share: number;
      shareThreshold: number;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateSpike(i: SpikeInput): SpikeVerdict {
  if (!i.firstLiveAt || i.firstLiveAt.getTime() > i.now.getTime() - LEARNING_DAYS * DAY_MS) {
    return { fire: false, reason: 'learning' };
  }
  if (i.windowNegatives < i.minCount) {
    return { fire: false, reason: 'below_min' };
  }
  const k = SENSITIVITY_MULTIPLIER[i.sensitivity];
  const expectedPerHour =
    i.baselineHours > 0
      ? Math.max(DEFAULT_BASELINE_PER_HOUR, i.baselineNegatives / i.baselineHours)
      : DEFAULT_BASELINE_PER_HOUR;
  const volumeThreshold = k * expectedPerHour;
  const baselineShare = i.baselineTotal > 0 ? i.baselineNegatives / i.baselineTotal : 0;
  const shareThreshold = Math.min(SHARE_CEILING, Math.max(SHARE_FLOOR, k * baselineShare));
  const share = i.windowTotal > 0 ? i.windowNegatives / i.windowTotal : 0;
  const detail = { expectedPerHour, volumeThreshold, share, shareThreshold };
  if (i.windowNegatives >= volumeThreshold) {
    return { fire: true, trigger: 'volume', ...detail };
  }
  if (share >= shareThreshold) {
    return { fire: true, trigger: 'share', ...detail };
  }
  return { fire: false, reason: 'within_baseline' };
}

export interface SpikeState {
  episodeId: string | null;
  cooldownUntil: Date | null;
  triggerCount: number | null;
  escalated: boolean;
}

export function nextSpikeState(
  s: SpikeState,
  v: SpikeVerdict,
  windowNegatives: number,
  now: Date,
  cooldownMinutes: number,
  newId: () => string,
): { state: SpikeState; emit: null | 'negative_spike' | 'spike_escalation' } {
  if (!v.fire) return { state: s, emit: null };
  const inCooldown = s.cooldownUntil !== null && s.cooldownUntil.getTime() > now.getTime();
  if (!inCooldown) {
    return {
      state: {
        episodeId: newId(),
        cooldownUntil: new Date(now.getTime() + cooldownMinutes * 60_000),
        triggerCount: windowNegatives,
        escalated: false,
      },
      emit: 'negative_spike',
    };
  }
  if (
    !s.escalated &&
    s.triggerCount !== null &&
    windowNegatives >= ESCALATION_FACTOR * s.triggerCount
  ) {
    return { state: { ...s, escalated: true }, emit: 'spike_escalation' };
  }
  return { state: s, emit: null };
}
