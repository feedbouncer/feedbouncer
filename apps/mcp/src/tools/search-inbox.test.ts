import { afterEach, describe, expect, it } from 'vitest';
import { makeComment } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

describe('search_inbox', () => {
  it('passes the query as q along with the filters', async () => {
    h = await connect();
    h.api.page = { data: [makeComment()], nextCursor: null };
    const r = await h.call('search_inbox', { query: 'refund', status: 'flagged', limit: 3 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('<untrusted_comment');
    expect(h.api.callsTo('listComments')).toEqual([[{ q: 'refund', status: 'flagged', limit: 3 }]]);
  });

  it.each([{}, { query: 'a' }, { query: 'x'.repeat(201) }])(
    'rejects %o without calling the API',
    async (args) => {
      h = await connect();
      const r = await h.call('search_inbox', args);
      expect(r.isError).toBe(true);
      expect(h.api.calls).toEqual([]);
    },
  );
});
