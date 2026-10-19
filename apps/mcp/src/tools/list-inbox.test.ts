import { afterEach, describe, expect, it } from 'vitest';
import { UNTRUSTED_NOTICE } from '../present.js';
import { BRAND_ID, COMMENT_ID, makeComment } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

describe('list_inbox', () => {
  it('passes filters and cursor through, mapping from/to to posted dates', async () => {
    h = await connect();
    await h.call('list_inbox', {
      brandId: BRAND_ID,
      status: 'unanswered',
      platform: 'instagram',
      from: '2026-10-01T00:00:00+02:00',
      to: '2026-10-02T00:00:00Z',
      limit: 5,
      cursor: 'abc',
    });
    expect(h.api.callsTo('listComments')).toEqual([
      [
        {
          brandId: BRAND_ID,
          status: 'unanswered',
          platform: 'instagram',
          postedFrom: '2026-10-01T00:00:00+02:00',
          postedTo: '2026-10-02T00:00:00Z',
          limit: 5,
          cursor: 'abc',
        },
      ],
    ]);
  });

  it('defaults limit to 20', async () => {
    h = await connect();
    await h.call('list_inbox', {});
    expect(h.api.callsTo('listComments')).toEqual([[{ limit: 20 }]]);
  });

  it('frames public text in both content and structuredContent', async () => {
    h = await connect();
    const comment = makeComment({ authorName: 'Eve', text: 'buy <now>' });
    h.api.page = { data: [comment], nextCursor: 'next-1' };
    const r = await h.call('list_inbox', {});
    expect(r.isError).toBeFalsy();
    expect(r.content[0]).toEqual({ type: 'text', text: UNTRUSTED_NOTICE });
    const text = textOf(r);
    expect(text).toContain(
      `<untrusted_comment id="${COMMENT_ID}">buy &lt;now&gt;</untrusted_comment>`,
    );
    expect(text).toContain(`<untrusted_author id="${COMMENT_ID}">Eve</untrusted_author>`);
    expect(text).toContain('nextCursor: next-1');
    expect(r.structuredContent).toEqual({
      comments: [
        {
          ...comment,
          authorName: `<untrusted_author id="${COMMENT_ID}">Eve</untrusted_author>`,
          text: `<untrusted_comment id="${COMMENT_ID}">buy &lt;now&gt;</untrusted_comment>`,
        },
      ],
      nextCursor: 'next-1',
    });
  });

  it('keeps a null author null in structuredContent', async () => {
    h = await connect();
    h.api.page = { data: [makeComment({ authorName: null })], nextCursor: null };
    const r = await h.call('list_inbox', {});
    const { comments } = r.structuredContent as { comments: { authorName: unknown }[] };
    expect(comments[0]!.authorName).toBeNull();
  });

  it('returns "No comments match." for an empty page without an error', async () => {
    h = await connect();
    const r = await h.call('list_inbox', {});
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('No comments match.');
    expect(r.structuredContent).toEqual({ comments: [], nextCursor: null });
  });

  it.each([
    { limit: 51 },
    { limit: 0 },
    { brandId: 'not-a-uuid' },
    { from: '2026-10-01T00:00:00' },
    { cursor: 'x'.repeat(513) },
  ])('rejects %o without calling the API', async (args) => {
    h = await connect();
    const r = await h.call('list_inbox', args);
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
