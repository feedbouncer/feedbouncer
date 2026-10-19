import { afterEach, describe, expect, it } from 'vitest';
import { ApiCallError } from '../api-client.js';
import { COMMENT_ID } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

describe('set_comment_visibility', () => {
  it('hides a comment with a fresh idempotency key', async () => {
    h = await connect();
    const r = await h.call('set_comment_visibility', {
      commentId: COMMENT_ID,
      visibility: 'hidden',
    });
    expect(r.structuredContent).toEqual({ changed: true, status: 'applied' });
    const [id, visibility, key] = h.api.callsTo('setVisibility')[0]!;
    expect([id, visibility]).toEqual([COMMENT_ID, 'hidden']);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports a pending change as changed', async () => {
    h = await connect();
    h.api.visibilityAction = { status: 'pending' };
    const r = await h.call('set_comment_visibility', {
      commentId: COMMENT_ID,
      visibility: 'visible',
      idempotencyKey: 'k1',
    });
    expect(r.structuredContent).toEqual({ changed: true, status: 'pending' });
    expect(h.api.callsTo('setVisibility')[0]![2]).toBe('k1');
  });

  it('reports a noop as unchanged', async () => {
    h = await connect();
    h.api.visibilityAction = { status: 'noop', code: 'already_hidden' };
    const r = await h.call('set_comment_visibility', {
      commentId: COMMENT_ID,
      visibility: 'hidden',
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ changed: false, reason: 'already_hidden' });
    expect(textOf(r)).toBe('Already hidden — nothing changed.');
  });

  it('gives an actionable error for an unknown comment', async () => {
    h = await connect();
    h.api.error = new ApiCallError(404, 'not_found', 'Not found');
    const r = await h.call('set_comment_visibility', {
      commentId: COMMENT_ID,
      visibility: 'visible',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('List the inbox to get current IDs.');
  });

  it('rejects an unknown visibility without calling the API', async () => {
    h = await connect();
    const r = await h.call('set_comment_visibility', {
      commentId: COMMENT_ID,
      visibility: 'deleted',
    });
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
