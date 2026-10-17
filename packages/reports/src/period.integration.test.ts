import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb } from '@feedbouncer/db/testing';
import { periodForWeek, reportPeriod } from './period.js';

let h: Awaited<ReturnType<typeof migratedDb>>;

beforeAll(async () => {
  h = await migratedDb();
});
afterAll(async () => {
  await h.close();
});

const iso = (d: Date) => d.toISOString();
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

describe('reportPeriod', () => {
  it('UTC: now 2026-10-19T08:00Z gives the previous Mon-Sun week', async () => {
    const p = await reportPeriod(h.c, 'UTC', new Date('2026-10-19T08:00:00Z'));
    expect(p.weekStart).toBe('2026-10-12');
    expect(p.timezone).toBe('UTC');
    expect(iso(p.start)).toBe('2026-10-12T00:00:00.000Z');
    expect(iso(p.end)).toBe('2026-10-19T00:00:00.000Z');
    expect(iso(p.prevStart)).toBe('2026-10-05T00:00:00.000Z');
    expect(iso(p.dueAt)).toBe('2026-10-19T08:00:00.000Z');
  });

  it('across DST: Berlin fall-back and New York spring-forward', async () => {
    const berlin = await reportPeriod(h.c, 'Europe/Berlin', new Date('2026-10-26T07:00:00Z'));
    expect(iso(berlin.start)).toBe('2026-10-18T22:00:00.000Z');
    expect(iso(berlin.end)).toBe('2026-10-25T23:00:00.000Z');
    expect(hours(berlin.start, berlin.end)).toBe(169);
    expect(iso(berlin.dueAt)).toBe('2026-10-26T07:00:00.000Z');

    const ny = await reportPeriod(h.c, 'America/New_York', new Date('2026-03-09T12:00:00Z'));
    expect(iso(ny.start)).toBe('2026-03-02T05:00:00.000Z');
    expect(iso(ny.end)).toBe('2026-03-09T04:00:00.000Z');
    expect(hours(ny.start, ny.end)).toBe(167);
    expect(iso(ny.dueAt)).toBe('2026-03-09T12:00:00.000Z');
  });

  it('Pacific/Kiritimati (UTC+14) and Pacific/Pago_Pago (UTC-11) differ on the same instant', async () => {
    const now = new Date('2026-10-18T12:00:00Z');
    const ahead = await reportPeriod(h.c, 'Pacific/Kiritimati', now);
    const behind = await reportPeriod(h.c, 'Pacific/Pago_Pago', now);
    expect(ahead.weekStart).toBe('2026-10-12');
    expect(behind.weekStart).toBe('2026-10-05');
  });

  it('Sunday 23:59 local belongs to the ending week; Monday 00:00 local to the next', async () => {
    const tz = 'Europe/Berlin';
    const sunday = await reportPeriod(h.c, tz, new Date('2026-10-18T21:59:00Z'));
    const monday = await reportPeriod(h.c, tz, new Date('2026-10-18T22:00:00Z'));
    expect(sunday.weekStart).toBe('2026-10-05');
    expect(monday.weekStart).toBe('2026-10-12');
  });
});

describe('periodForWeek', () => {
  it('rejects a Tuesday; accepts 2026-10-12 and equals reportPeriod for that week', async () => {
    expect(await periodForWeek(h.c, 'UTC', '2026-10-13')).toBeNull();
    const p = await periodForWeek(h.c, 'Europe/Berlin', '2026-10-12');
    expect(p).toEqual(await reportPeriod(h.c, 'Europe/Berlin', new Date('2026-10-19T12:00:00Z')));
  });
});
