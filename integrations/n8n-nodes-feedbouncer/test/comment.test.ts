import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { FeedBouncer } from '../nodes/FeedBouncer/FeedBouncer.node';
import { fakeExecute } from './fakes';
import type { FakeInit, Scripted } from './fakes';

const ID = '0b9c2f7e-8a4d-4c1e-9f3a-1d2e3f4a5b6c';
const ID2 = '1c0d3a8f-9b5e-4d2f-8a4b-2e3f4a5b6c7d';

const comment = (id: string, text = 'hello') => ({ id, text, status: 'visible' });
const ok = (body: unknown): Scripted => ({ status: 200, body });

const run = (init: FakeInit) => {
  const ctx = fakeExecute(init);
  return { ctx, result: new FeedBouncer().execute.call(ctx) };
};

describe('comment get', () => {
  it('sends GET /v1/comments/<id> and outputs the resource unchanged', async () => {
    const resource = { ...comment(ID), extra: { nested: [1, 2] } };
    const { ctx, result } = run({ params: { resource: 'comment', operation: 'get', commentId: ID }, http: [ok(resource)] });
    const [items] = await result;
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({ method: 'GET', url: `https://fb.acme.io/v1/comments/${ID}` });
    expect(items).toEqual([{ json: resource, pairedItem: { item: 0 } }]);
  });

  it('with a non-UUID id fails before any HTTP call', async () => {
    const { ctx, result } = run({ params: { resource: 'comment', operation: 'get', commentId: '../keys' } });
    await expect(result).rejects.toThrow('Comment ID must be a FeedBouncer ID (a UUID).');
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('comment list', () => {
  it('maps filters to the query string', async () => {
    const brandId = ID2;
    const { ctx, result } = run({
      params: {
        resource: 'comment',
        operation: 'list',
        returnAll: false,
        limit: 20,
        filters: {
          status: 'hidden',
          brandId,
          platform: 'instagram',
          search: 'refund',
          postedAfter: '2026-10-01T12:30:00.000Z',
          postedBefore: '2026-10-19T00:00:00+02:00',
        },
      },
      http: [ok({ data: [comment(ID)], nextCursor: null })],
    });
    await result;
    expect(ctx.calls[0].qs).toEqual({
      limit: 20,
      status: 'hidden',
      brandId,
      platform: 'instagram',
      q: 'refund',
      postedFrom: '2026-10-01T12:30:00.000Z',
      postedTo: '2026-10-18T22:00:00.000Z',
    });
  });

  it('adds an offset to a zone-less date', async () => {
    const { ctx, result } = run({
      params: { resource: 'comment', operation: 'list', returnAll: false, limit: 5, filters: { postedAfter: '2026-10-01T12:30:00' } },
      http: [ok({ data: [], nextCursor: null })],
    });
    await result;
    expect(String(ctx.calls[0].qs?.postedFrom)).toMatch(/Z$|[+-]\d\d:\d\d$/);
  });

  it('rejects a search outside 2 to 200 characters before any HTTP call', async () => {
    for (const search of ['a', 'x'.repeat(201)]) {
      const { ctx, result } = run({
        params: { resource: 'comment', operation: 'list', returnAll: false, limit: 5, filters: { search } },
      });
      await expect(result).rejects.toThrow('Search must be 2 to 200 characters.');
      expect(ctx.calls).toHaveLength(0);
    }
  });

  it('return all walks cursors', async () => {
    const { ctx, result } = run({
      params: { resource: 'comment', operation: 'list', returnAll: true },
      http: [
        ok({ data: [comment(ID), comment(ID2)], nextCursor: 'next' }),
        ok({ data: [comment('3d1e4b9a-0c6f-4e3a-9b5c-3f4a5b6c7d8e')], nextCursor: null }),
      ],
    });
    const [items] = await result;
    expect(items).toHaveLength(3);
    expect(ctx.calls[0].qs).toEqual({ limit: 100 });
    expect(ctx.calls[1].qs).toEqual({ limit: 100, cursor: 'next' });
  });

  it('an empty result gives no items and no error', async () => {
    const { result } = run({
      params: { resource: 'comment', operation: 'list', returnAll: false, limit: 50 },
      http: [ok({ data: [], nextCursor: null })],
    });
    expect(await result).toEqual([[]]);
  });

  it('turns the 10,000 cap into a readable error', async () => {
    const page = (n: number) => ok({ data: Array.from({ length: 100 }, (_, k) => comment(`${n}-${k}`)), nextCursor: `c${n}` });
    const { result } = run({
      params: { resource: 'comment', operation: 'list', returnAll: true },
      http: Array.from({ length: 100 }, (_, n) => page(n)),
    });
    await expect(result).rejects.toThrow(
      'More than 10,000 comments match. Narrow the filters or turn off Return All and set a Limit.',
    );
  });
});

describe('item handling', () => {
  it('two input items make two independent requests with pairedItem 0 and 1', async () => {
    const { ctx, result } = run({
      params: { resource: 'comment', operation: 'get', commentId: ID },
      items: [{}, {}],
      http: [ok(comment(ID)), ok(comment(ID))],
    });
    const [items] = await result;
    expect(ctx.calls).toHaveLength(2);
    expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('continueOnFail: item 0 404, item 1 ok gives an error item then the comment', async () => {
    const ctx = fakeExecute({
      params: { resource: 'comment', operation: 'get', commentId: ID },
      items: [{}, {}],
      http: [{ status: 404, body: { error: { code: 'not_found', message: 'nope' } } }, ok(comment(ID))],
    });
    ctx.continueOnFail = () => true;
    const [items] = await new FeedBouncer().execute.call(ctx);
    expect(items).toHaveLength(2);
    expect(items[0].json).toMatchObject({ httpCode: '404' });
    expect(items[0].json.error).toContain(ID);
    expect(items[0].pairedItem).toEqual({ item: 0 });
    expect(items[1]).toEqual({ json: comment(ID), pairedItem: { item: 1 } });
  });

  it('without continueOnFail the error propagates', async () => {
    const { result } = run({
      params: { resource: 'comment', operation: 'get', commentId: ID },
      http: [{ status: 404, body: { error: { code: 'not_found', message: 'nope' } } }],
    });
    await expect(result).rejects.toBeInstanceOf(NodeApiError);
  });
});

describe('text fidelity', () => {
  it('emoji, accents and 10,000 astral code points arrive byte-identical', async () => {
    const texts = ['Hi 😀👍🏽 – ünïcödé', '😀'.repeat(10_000), '  padded \n'];
    const { result } = run({
      params: { resource: 'comment', operation: 'list', returnAll: false, limit: 50 },
      http: [ok({ data: texts.map((text, n) => ({ id: String(n), text })), nextCursor: null })],
    });
    const [items] = await result;
    expect(items.map((item) => item.json.text)).toEqual(texts);
    expect(Array.from(String(items[1].json.text))).toHaveLength(10_000);
  });
});
