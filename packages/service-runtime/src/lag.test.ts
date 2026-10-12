import { expect, it } from 'vitest';
import { clampLag } from './lag.js';

it('measures ordinary lag', () =>
  expect(clampLag(1_000, 4_000)).toEqual({ lagMs: 3_000, skewMs: 0 }));
it('zero lag is zero, not skew', () =>
  expect(clampLag(5_000, 5_000)).toEqual({ lagMs: 0, skewMs: 0 }));
it('clamps negative lag and reports the skew', () =>
  expect(clampLag(9_000, 4_000)).toEqual({ lagMs: 0, skewMs: 5_000 }));
it('treats non-finite input as zero lag', () =>
  expect(clampLag(Number.NaN, 4_000)).toEqual({ lagMs: 0, skewMs: 0 }));
