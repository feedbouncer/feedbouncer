import { LOW_CONFIDENCE_N, WILSON_Z } from './constants.js';

export type Confidence = 'ok' | 'low_confidence' | 'not_enough_data';

export function confidenceOf(n: number): Confidence {
  if (n <= 0) return 'not_enough_data';
  return n < LOW_CONFIDENCE_N ? 'low_confidence' : 'ok';
}

/** Wilson score interval, clamped to [0, 1]. */
export function wilson(k: number, n: number): [number, number] {
  if (!(n > 0)) throw new RangeError('wilson requires n > 0');
  const z = WILSON_Z;
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const denom = 1 + (z * z) / n;
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

export type Rate =
  | { status: 'not_enough_data'; n: 0 }
  | {
      status: 'ok' | 'low_confidence';
      k: number;
      n: number;
      value: number;
      ci95: [number, number];
    };

export function rate(k: number, n: number): Rate {
  if (n <= 0) return { status: 'not_enough_data', n: 0 };
  return {
    status: confidenceOf(n) as 'ok' | 'low_confidence',
    k,
    n,
    value: k / n,
    ci95: wilson(k, n),
  };
}

export type Distribution =
  | { status: 'not_enough_data'; n: 0 }
  | { status: 'ok' | 'low_confidence'; n: number; p50: number; p95: number; max: number };

export function distribution(values: readonly number[]): Distribution {
  const n = values.length;
  if (n === 0) return { status: 'not_enough_data', n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil((p / 100) * n) - 1]!;
  return {
    status: confidenceOf(n) as 'ok' | 'low_confidence',
    n,
    p50: at(50),
    p95: at(95),
    max: sorted[n - 1]!,
  };
}

/** Cohen's kappa for two boolean raters; null when n=0 or expected agreement is 1. */
export function cohenKappa(pairs: readonly (readonly [boolean, boolean])[]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  let agree = 0;
  let aTrue = 0;
  let bTrue = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree++;
    if (a) aTrue++;
    if (b) bTrue++;
  }
  const po = agree / n;
  const pe = (aTrue / n) * (bTrue / n) + (1 - aTrue / n) * (1 - bTrue / n);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}
