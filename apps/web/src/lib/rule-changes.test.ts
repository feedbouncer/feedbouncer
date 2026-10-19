import { afterEach, describe, expect, it } from 'vitest';
import {
  approveRuleChange,
  decideRuleChange,
  getRuleChange,
  listRuleChanges,
  rejectRuleChange,
  ruleChangeErrorText,
  valueText,
} from './rule-changes';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(res: Response): Array<[string, RequestInit]> {
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return res.clone();
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const error = (code: string, status: number) =>
  json({ error: { code, message: 'server text' } }, status);
const BASE = '/api/v1/orgs/o/brands/b/rule-changes';

describe('rule change requests', () => {
  it('lists changes, optionally filtered by status, and unwraps the envelope', async () => {
    const calls = stubFetch(json({ changes: [{ id: 'c1' }] }));
    await expect(listRuleChanges('o', 'b')).resolves.toEqual([{ id: 'c1' }]);
    await listRuleChanges('o', 'b', 'pending');
    expect(calls[0]![0]).toBe(BASE);
    expect(calls[1]![0]).toBe(`${BASE}?status=pending`);
  });

  it('gets one change', async () => {
    const calls = stubFetch(json({ id: 'c1' }));
    await expect(getRuleChange('o', 'b', 'c1')).resolves.toEqual({ id: 'c1' });
    expect(calls[0]![0]).toBe(`${BASE}/c1`);
  });

  it('posts approve and reject with an optional note', async () => {
    const calls = stubFetch(json({ id: 'c1' }));
    await approveRuleChange('o', 'b', 'c1');
    await rejectRuleChange('o', 'b', 'c1', 'no thanks');
    expect(calls[0]![0]).toBe(`${BASE}/c1/approve`);
    expect(calls[0]![1].method).toBe('POST');
    expect(calls[0]![1].body).toBe('{}');
    expect(calls[1]![0]).toBe(`${BASE}/c1/reject`);
    expect(calls[1]![1].body).toBe(JSON.stringify({ note: 'no thanks' }));
  });
});

describe('ruleChangeErrorText', () => {
  it.each([
    ['proposal_stale', 'Rules changed since this was proposed — ask for a new proposal'],
    ['proposal_expired', 'This proposal expired. Ask for a new one.'],
    ['proposal_not_pending', 'This proposal was already decided. Reload the page.'],
  ])('maps %s', async (code, text) => {
    stubFetch(error(code, 409));
    await expect(decideRuleChange('approve', 'o', 'b', 'c1')).resolves.toBe(text);
  });

  it.each([
    ['invalid_actions', 422],
    ['rule_limit_reached', 409],
  ])('explains that %s blocks approval and suggests rejecting', async (code, status) => {
    stubFetch(error(code, status));
    const text = await decideRuleChange('approve', 'o', 'b', 'c1');
    expect(text).toContain('cannot be approved');
    expect(text).toContain('Reject');
  });

  it('falls back to the shared message for other codes and a generic one otherwise', async () => {
    stubFetch(error('forbidden', 403));
    expect(await decideRuleChange('reject', 'o', 'b', 'c1')).not.toBe('server text');
    globalThis.fetch = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect(await decideRuleChange('reject', 'o', 'b', 'c1')).toBe('Something went wrong.');
    expect(ruleChangeErrorText(new TypeError('x'))).toBe('Something went wrong.');
  });

  it('returns null on success', async () => {
    stubFetch(json({ id: 'c1' }));
    await expect(decideRuleChange('reject', 'o', 'b', 'c1')).resolves.toBeNull();
  });
});

describe('valueText', () => {
  it('renders absent values as a dash and others as compact text', () => {
    expect(valueText(null)).toBe('—');
    expect(valueText('hide')).toBe('hide');
    expect(valueText(['a', 'b'])).toBe('["a","b"]');
    expect(valueText(true)).toBe('true');
  });
});
