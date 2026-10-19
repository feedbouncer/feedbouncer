import { PAGE_SIZE, RETURN_ALL_MAX } from './constants';

export class ReturnAllLimitError extends Error {}

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Follows cursors until `limit` items are collected, or, with `returnAll`, until the list ends or hits RETURN_ALL_MAX. */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined, pageLimit: number) => Promise<Page<T>>,
  opts: { returnAll: boolean; limit: number },
): Promise<T[]> {
  const cap = opts.returnAll ? RETURN_ALL_MAX : opts.limit;
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, Math.min(PAGE_SIZE, cap - items.length));
    items.push(...page.data);
    if (!page.nextCursor || page.data.length === 0) return items;
    if (items.length >= cap) {
      if (opts.returnAll) throw new ReturnAllLimitError('Return All stopped at the maximum.');
      return items.slice(0, cap);
    }
    cursor = page.nextCursor;
  }
}
