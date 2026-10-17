import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWeeklyReport, parseWeekParam } from './reports';

const serverGet = vi.hoisted(() => vi.fn());
vi.mock('./server-api', () => ({
  serverGet,
  dataOrThrow: <T>(r: { status: number; data: T | null }) => {
    if (r.data) return r.data;
    throw new Error(`status ${r.status}`);
  },
}));

const ORG = '11111111-2222-4333-8444-555555555555';

describe('parseWeekParam', () => {
  it("parseWeekParam rejects '2026-13-01', '../x', arrays", () => {
    for (const v of ['2026-13-01', '../x', ['2026-10-12'], '2026-02-30', '2026-10-13', '', 5])
      expect(parseWeekParam(v), String(v)).toBeUndefined();
    expect(parseWeekParam(undefined)).toBeUndefined();
  });

  it('accepts a real Monday', () => {
    expect(parseWeekParam('2026-10-12')).toBe('2026-10-12');
  });
});

describe('fetchWeeklyReport', () => {
  beforeEach(() => serverGet.mockReset());

  it('asks for the given week, or the default week without one', async () => {
    serverGet.mockResolvedValue({ status: 200, data: { weekStart: '2026-10-05' } });
    await fetchWeeklyReport(ORG, '2026-10-05');
    await fetchWeeklyReport(ORG);
    expect(serverGet.mock.calls).toEqual([
      [`/api/v1/orgs/${ORG}/reports/weekly?week=2026-10-05`],
      [`/api/v1/orgs/${ORG}/reports/weekly`],
    ]);
  });

  it('a refused week is null; other failures throw', async () => {
    serverGet.mockResolvedValueOnce({ status: 400, data: null });
    expect(await fetchWeeklyReport(ORG, '2020-01-06')).toBeNull();
    serverGet.mockResolvedValueOnce({ status: 500, data: null });
    await expect(fetchWeeklyReport(ORG)).rejects.toThrow();
  });
});
