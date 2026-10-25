import { describe, expect, it } from 'vitest';
import { nextPacificMidnight, pacificDayKey } from './quota-day.js';

describe('pacific quota day', () => {
  it('keys the day by the America/Los_Angeles calendar date, not UTC', () => {
    expect(pacificDayKey(Date.parse('2026-10-25T03:00:00Z'))).toBe('2026-10-24');
    expect(pacificDayKey(Date.parse('2026-03-08T07:59:59Z'))).toBe('2026-03-07');
    expect(pacificDayKey(Date.parse('2026-03-08T08:00:00Z'))).toBe('2026-03-08');
    expect(pacificDayKey(Date.parse('2026-11-02T07:30:00Z'))).toBe('2026-11-01');
  });

  it('resets at the next Pacific midnight across DST', () => {
    // 23h day (spring forward)
    expect(nextPacificMidnight(Date.parse('2026-03-08T12:00:00Z')).toISOString()).toBe(
      '2026-03-09T07:00:00.000Z',
    );
    // 25h day (fall back)
    expect(nextPacificMidnight(Date.parse('2026-11-01T12:00:00Z')).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(nextPacificMidnight(Date.parse('2026-11-02T07:59:59.999Z')).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('crosses into a DST-change day at its own midnight', () => {
    expect(nextPacificMidnight(Date.parse('2026-03-07T20:00:00Z')).toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    expect(nextPacificMidnight(Date.parse('2026-10-31T20:00:00Z')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    // Exactly at midnight, the next reset is a full day later.
    expect(nextPacificMidnight(Date.parse('2026-10-25T07:00:00Z')).toISOString()).toBe(
      '2026-10-26T07:00:00.000Z',
    );
  });
});
