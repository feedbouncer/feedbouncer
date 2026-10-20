import { NodeApiError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedBouncer } from '../nodes/FeedBouncer/FeedBouncer.node';
import { fakeExecute, slept } from './fakes';
import type { FakeInit, Scripted } from './fakes';

vi.mock('n8n-workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('n8n-workflow')>();
  return {
    ...actual,
    sleep: async (ms: number) => {
      (await import('./fakes.js')).slept.push(ms);
    },
  };
});

const ID = '0b9c2f7e-8a4d-4c1e-9f3a-1d2e3f4a5b6c';
const ACTION = '2d1e4b9a-0c6f-4e3a-9b5c-3f4a5b6c7d8e';
const comment = { id: ID, text: 'hello', status: 'hidden' };
const moderation = (status: string, code: string | null = null, kind = 'hide') => ({
  action: { id: ACTION, kind, status, code },
  comment,
});
const action = (status: string, code: string | null = null) => ({
  id: ACTION,
  kind: 'hide',
  commentId: ID,
  status,
  code,
  platformRef: null,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
});
const accepted = (body: unknown = moderation('pending')): Scripted => ({ status: 202, body });
const ok = (body: unknown): Scripted => ({ status: 200, body });
const envelope = (code: string, message = 'boom') => ({ error: { code, message } });

const run = (init: FakeInit, operation = 'hide') => {
  const ctx = fakeExecute({ params: { resource: 'decision', operation, commentId: ID }, ...init });
  return { ctx, result: new FeedBouncer().execute.call(ctx) };
};

beforeEach(() => {
  slept.length = 0;
});

describe('decision hide', () => {
  it('sends POST /v1/comments/<id>/hide with the default Idempotency-Key', async () => {
    const { ctx, result } = run({ http: [ok(moderation('noop', 'already_hidden'))] });
    await result;
    expect(ctx.calls[0]).toMatchObject({ method: 'POST', url: `https://fb.acme.io/v1/comments/${ID}/hide` });
    expect(ctx.calls[0].headers['Idempotency-Key']).toBe(`n8n.123.node-1.0.0.hide.${ID}`);
    expect(ctx.calls[0].body).toBeUndefined();
  });

  it('differs between runs of the node in one execution, as inside Loop Over Items', async () => {
    const keys: string[] = [];
    for (const runIndex of [0, 1]) {
      const { ctx, result } = run({ runIndex, http: [ok(moderation('noop', 'already_hidden'))] });
      await result;
      keys.push(ctx.calls[0].headers['Idempotency-Key']);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a retry within the same execution (Retry On Fail) sends an identical Idempotency-Key', async () => {
    const keys: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { ctx, result } = run({ http: [ok(moderation('noop', 'already_hidden'))] });
      await result;
      keys.push(ctx.calls[0].headers['Idempotency-Key']);
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it('a user key overrides the default; an invalid key fails without HTTP', async () => {
    const options = { idempotencyKey: 'my-key.1' };
    const { ctx, result } = run({ params: { resource: 'decision', operation: 'hide', commentId: ID, options }, http: [ok(moderation('noop', 'already_hidden'))] });
    await result;
    expect(ctx.calls[0].headers['Idempotency-Key']).toBe('my-key.1');

    const bad = run({ params: { resource: 'decision', operation: 'hide', commentId: ID, options: { idempotencyKey: 'a b' } } });
    await expect(bad.result).rejects.toThrow('Idempotency Key may use 1 to 128 letters, digits and . _ : - only.');
    expect(bad.ctx.calls).toHaveLength(0);
  });

  it('a non-UUID comment id fails before any HTTP call', async () => {
    const { ctx, result } = run({ params: { resource: 'decision', operation: 'hide', commentId: 'x' } });
    await expect(result).rejects.toThrow('Comment ID must be a FeedBouncer ID (a UUID).');
    expect(ctx.calls).toHaveLength(0);
  });

  it('202 pending polls getAction until applied', async () => {
    const { ctx, result } = run({ http: [accepted(), ok(action('pending')), ok(action('applied'))] });
    const [items] = await result;
    expect(ctx.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST https://fb.acme.io/v1/comments/${ID}/hide`,
      `GET https://fb.acme.io/v1/actions/${ACTION}`,
      `GET https://fb.acme.io/v1/actions/${ACTION}`,
    ]);
    expect(slept).toEqual([1000, 1000]);
    expect(items).toEqual([
      {
        json: { action: { id: ACTION, kind: 'hide', status: 'applied', code: null }, comment, changed: true },
        pairedItem: { item: 0 },
      },
    ]);
  });

  it('200 noop already_hidden gives changed false and no polling', async () => {
    const { ctx, result } = run({ http: [ok(moderation('noop', 'already_hidden'))] });
    const [items] = await result;
    expect(ctx.calls).toHaveLength(1);
    expect(items[0].json).toEqual({
      action: { id: ACTION, kind: 'hide', status: 'noop', code: 'already_hidden' },
      comment,
      changed: false,
    });
  });

  it('still pending after 15 s succeeds as pending', async () => {
    const http: Scripted[] = [accepted(), ...Array.from({ length: 15 }, () => ok(action('pending')))];
    const { ctx, result } = run({ http });
    const [items] = await result;
    expect(ctx.calls).toHaveLength(16);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(15_000);
    expect(items[0].json).toMatchObject({ action: { status: 'pending' }, changed: true });
  });

  it('waitForResult false makes no getAction call', async () => {
    const { ctx, result } = run({
      params: { resource: 'decision', operation: 'hide', commentId: ID, options: { waitForResult: false } },
      http: [accepted()],
    });
    const [items] = await result;
    expect(ctx.calls).toHaveLength(1);
    expect(items[0].json).toMatchObject({ action: { status: 'pending' }, changed: true });
  });

  it('a failed action raises a NodeApiError; continueOnFail keeps the code', async () => {
    const http = (): Scripted[] => [accepted(), ok(action('failed', 'platform_rejected'))];
    const first = run({ http: http() });
    const error = (await first.result.catch((e: unknown) => e)) as NodeApiError;
    expect(error).toBeInstanceOf(NodeApiError);
    expect(error.message).toBe(`FeedBouncer could not hide comment ${ID}: platform_rejected.`);

    const ctx = fakeExecute({ params: { resource: 'decision', operation: 'hide', commentId: ID }, http: http() });
    ctx.continueOnFail = () => true;
    const [items] = await new FeedBouncer().execute.call(ctx);
    expect(items[0].json).toMatchObject({
      error: `FeedBouncer could not hide comment ${ID}: platform_rejected.`,
      code: 'platform_rejected',
    });
  });

  it('a not_eligible answer is an error too', async () => {
    const { result } = run({ http: [ok(moderation('not_eligible', 'comment_gone'))] });
    await expect(result).rejects.toThrow(`FeedBouncer could not hide comment ${ID}: comment_gone.`);
  });

  it('a read-only key names the credential', async () => {
    const { result } = run({ http: [{ status: 403, body: envelope('insufficient_scope') }] });
    await expect(result).rejects.toThrow('The API key in credential "FeedBouncer API" is read-only.');
  });
});

describe('decision undoHide', () => {
  it('posts to /unhide and words failures as undoing the hide', async () => {
    const { ctx, result } = run({ http: [ok(moderation('failed', 'platform_rejected', 'unhide'))] }, 'undoHide');
    await expect(result).rejects.toThrow(`FeedBouncer could not undo the hide of comment ${ID}: platform_rejected.`);
    expect(ctx.calls[0]).toMatchObject({ method: 'POST', url: `https://fb.acme.io/v1/comments/${ID}/unhide` });
    expect(ctx.calls[0].headers['Idempotency-Key']).toBe(`n8n.123.node-1.0.0.undoHide.${ID}`);
  });

  it('422 unsupported_action becomes a handled error carrying the API message', async () => {
    const { result } = run({ http: [{ status: 422, body: envelope('unsupported_action', 'Instagram cannot unhide.') }] }, 'undoHide');
    const error = (await result.catch((e: unknown) => e)) as NodeApiError;
    expect(error).toBeInstanceOf(NodeApiError);
    expect(error.message).toBe("This hide can't be undone on its platform.");
    expect(error.description).toBe('Instagram cannot unhide.');
    expect(error.context.code).toBe('unsupported_action');
  });
});

describe('routing', () => {
  it('an unsupported operation is a handled error', async () => {
    const { result } = run({}, 'explode');
    await expect(result).rejects.toThrow('Unsupported operation: explode.');
  });
});
