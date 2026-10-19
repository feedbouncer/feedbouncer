import { describe, expect, it } from 'vitest';
import { ReturnAllLimitError, collectPages } from '../nodes/shared/pagination';

type Page = { data: number[]; nextCursor: string | null };

function pager(pages: Page[]) {
  const calls: Array<{ cursor: string | undefined; pageLimit: number }> = [];
  const fetchPage = async (cursor: string | undefined, pageLimit: number) => {
    calls.push({ cursor, pageLimit });
    return pages[calls.length - 1] ?? { data: [], nextCursor: null };
  };
  return { calls, fetchPage };
}

const range = (count: number): number[] => Array.from({ length: count }, (_, n) => n);

describe('collectPages', () => {
  it('limit 150 asks for 100 then 50 and stops', async () => {
    const { calls, fetchPage } = pager([
      { data: range(100), nextCursor: 'c1' },
      { data: range(50), nextCursor: 'c2' },
    ]);
    const result = await collectPages(fetchPage, { returnAll: false, limit: 150 });
    expect(result).toHaveLength(150);
    expect(calls).toEqual([
      { cursor: undefined, pageLimit: 100 },
      { cursor: 'c1', pageLimit: 50 },
    ]);
  });

  it('stops on an empty page even when a cursor is returned', async () => {
    const { calls, fetchPage } = pager([
      { data: range(3), nextCursor: 'c1' },
      { data: [], nextCursor: 'c2' },
      { data: range(5), nextCursor: null },
    ]);
    expect(await collectPages(fetchPage, { returnAll: true, limit: 1 })).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it('return all follows nextCursor until null', async () => {
    const { calls, fetchPage } = pager([
      { data: range(100), nextCursor: 'c1' },
      { data: range(100), nextCursor: 'c2' },
      { data: range(7), nextCursor: null },
    ]);
    const result = await collectPages(fetchPage, { returnAll: true, limit: 1 });
    expect(result).toHaveLength(207);
    expect(calls.map((c) => c.cursor)).toEqual([undefined, 'c1', 'c2']);
  });

  it('return all stops at 10,000 and throws when more exist', async () => {
    const full = (cursor: string | null): Page => ({ data: range(100), nextCursor: cursor });
    const pages = Array.from({ length: 100 }, (_, n) => full(`c${n}`));
    const { calls, fetchPage } = pager(pages);
    await expect(collectPages(fetchPage, { returnAll: true, limit: 1 })).rejects.toBeInstanceOf(ReturnAllLimitError);
    expect(calls).toHaveLength(100);
  });

  it('return all returns exactly 10,000 when no cursor remains', async () => {
    const pages = Array.from({ length: 100 }, (_, n) => ({ data: range(100), nextCursor: n === 99 ? null : `c${n}` }));
    const { fetchPage } = pager(pages);
    expect(await collectPages(fetchPage, { returnAll: true, limit: 1 })).toHaveLength(10_000);
  });

  it('an empty first page returns [] after one call', async () => {
    const { calls, fetchPage } = pager([{ data: [], nextCursor: null }]);
    expect(await collectPages(fetchPage, { returnAll: false, limit: 50 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
