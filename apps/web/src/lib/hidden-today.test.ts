import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-client';
import {
  categoryLabel,
  hiddenTodayHref,
  reasonLines,
  sourceText,
  stateText,
  unhide,
  unhideErrorText,
  type HiddenItemDto,
} from './hidden-today';

const item = (over: Partial<HiddenItemDto> = {}): HiddenItemDto => ({
  hideActionId: '6f1c3a7e-1b2c-4d5e-8f90-123456789abc',
  organizationId: 'o',
  organizationName: 'Org',
  brandId: 'b',
  brandName: 'Brand',
  connectionId: 'c',
  connectionName: 'Shop Page',
  connectionStatus: 'active',
  platform: 'facebook',
  commentId: 'cm',
  commentBody: 'hello',
  commentState: 'hidden',
  authorName: 'Ann',
  hiddenAt: '2026-10-16T10:00:00.000Z',
  source: { type: 'system' },
  reason: null,
  lastAttempt: null,
  state: 'hidden',
  canUnhide: true,
  history: [],
  ...over,
});

describe('sourceText', () => {
  it('covers every source type, including a deleted rule and a missing user name', () => {
    expect(sourceText({ type: 'rule', ruleId: 'r', ruleName: 'No spam' })).toBe('Rule: No spam');
    expect(sourceText({ type: 'rule', ruleId: null, ruleName: null })).toBe('Rule (deleted)');
    expect(sourceText({ type: 'classifier', category: 'spam' })).toBe('AI classifier: Spam');
    expect(sourceText({ type: 'classifier', category: 'weird_code' })).toBe(
      'AI classifier: Flagged content',
    );
    expect(sourceText({ type: 'policy', policyId: 'p', policyName: 'Links' })).toBe(
      'Policy: Links',
    );
    expect(sourceText({ type: 'policy', policyId: null, policyName: null })).toBe(
      'Policy (deleted)',
    );
    expect(sourceText({ type: 'person', userName: 'Dana' })).toBe('Hidden by Dana');
    expect(sourceText({ type: 'person', userName: null })).toBe('Hidden by a teammate');
    expect(sourceText({ type: 'suggestion', userName: 'Dana' })).toBe(
      'Suggestion approved by Dana',
    );
    expect(sourceText({ type: 'system' })).toBe('FeedBouncer');
  });
});

describe('categoryLabel', () => {
  it('reuses classifier labels and falls back for unknown or missing codes', () => {
    expect(categoryLabel('scam_phishing')).toBe('Scam or phishing');
    expect(categoryLabel(null)).toBe('Flagged content');
    expect(categoryLabel('toString')).toBe('Flagged content');
  });
});

describe('reasonLines', () => {
  it('rule: matched line then the stored reason', () => {
    const i = item({
      source: { type: 'rule', ruleId: 'r', ruleName: 'No spam' },
      reason: 'Because.',
    });
    expect(reasonLines(i)).toEqual(["Matched your rule 'No spam'", 'Because.']);
    expect(reasonLines({ ...i, reason: null })).toEqual(["Matched your rule 'No spam'"]);
  });

  it('uses the stored reason for classifier, policy and suggestion', () => {
    const classifier = item({ source: { type: 'classifier', category: 'spam' }, reason: 'r1' });
    const policy = item({
      source: { type: 'policy', policyId: 'p', policyName: 'P' },
      reason: 'r2',
    });
    const suggestion = item({ source: { type: 'suggestion', userName: 'D' }, reason: 'r3' });
    expect(reasonLines(classifier)).toEqual(['r1']);
    expect(reasonLines(policy)).toEqual(['r2']);
    expect(reasonLines(suggestion)).toEqual(['r3']);
  });

  it('person without a reason is Hidden manually', () => {
    expect(reasonLines(item({ source: { type: 'person', userName: 'D' } }))).toEqual([
      'Hidden manually',
    ]);
  });

  it('classifier without a reason is Reason not recorded', () => {
    expect(reasonLines(item({ source: { type: 'classifier', category: 'spam' } }))).toEqual([
      'Reason not recorded',
    ]);
  });

  it("never returns '' or an internal code", () => {
    const sources: HiddenItemDto['source'][] = [
      { type: 'rule', ruleId: null, ruleName: null },
      { type: 'classifier', category: 'spam' },
      { type: 'policy', policyId: null, policyName: null },
      { type: 'person', userName: null },
      { type: 'suggestion', userName: null },
      { type: 'system' },
    ];
    for (const source of sources) {
      const lines = reasonLines(item({ source, reason: null }));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l).not.toBe('');
        expect(l).not.toMatch(/^[a-z_]+$/);
      }
    }
  });
});

describe('stateText', () => {
  it('has copy for every state', () => {
    expect(stateText(item({ state: 'hidden' }))).toBeNull();
    expect(stateText(item({ state: 'restored' }))).toEqual({ label: 'Restored', detail: null });
    expect(stateText(item({ state: 'already_visible' }))).toEqual({
      label: 'Already visible',
      detail: 'It was already visible on Facebook.',
    });
    expect(stateText(item({ state: 'unavailable', platform: 'instagram' }))).toEqual({
      label: 'No longer available',
      detail: 'This comment was deleted on Instagram.',
    });
    expect(stateText(item({ state: 'pending' }))).toEqual({
      label: 'Pending',
      detail: "Facebook is slow to respond. We'll keep trying.",
    });
  });

  it('pending while awaiting a reconnect says so', () => {
    const lastAttempt = {
      actionId: 'a',
      status: 'pending' as const,
      outcomeCode: 'awaiting_reconnect',
      createdAt: '2026-10-16T10:00:00.000Z',
      completedAt: null,
    };
    expect(stateText(item({ state: 'pending', lastAttempt }))?.detail).toBe(
      'Waiting for you to reconnect this account.',
    );
  });

  it('failed shows a plain-language detail, never the code', () => {
    const lastAttempt = {
      actionId: 'a',
      status: 'failed' as const,
      outcomeCode: 'rate_limit_exhausted',
      createdAt: '2026-10-16T10:00:00.000Z',
      completedAt: '2026-10-16T10:01:00.000Z',
    };
    const t = stateText(item({ state: 'failed', lastAttempt }));
    expect(t?.label).toBe("Couldn't unhide");
    expect(t?.detail).not.toContain('rate_limit_exhausted');
    expect(stateText(item({ state: 'failed' }))?.detail).toBeNull();
  });
});

describe('unhideErrorText', () => {
  const err = (status: number, code: string, permission?: string) =>
    new ApiRequestError(status, code, 'm', undefined, [], undefined, permission);

  it('maps the known 409s and falls back for everything else', () => {
    expect(unhideErrorText(err(409, 'connection_needs_reconnect'))).toEqual({
      text: 'Reconnect your account to unhide this comment.',
      reconnect: true,
    });
    expect(unhideErrorText(err(409, 'connection_inactive'))).toEqual({
      text: 'This account is disconnected. Reconnect it to unhide comments.',
      reconnect: true,
    });
    expect(unhideErrorText(err(409, 'missing_permission', 'pages_manage_engagement'))).toEqual({
      text: 'FeedBouncer doesn\'t have the "pages_manage_engagement" permission for this account. Reconnect and allow it to unhide comments.',
      reconnect: true,
    });
    const generic = { text: "Couldn't unhide, try again.", reconnect: false };
    expect(unhideErrorText(err(500, 'internal_error'))).toEqual(generic);
    expect(unhideErrorText(err(429, 'rate_limited'))).toEqual(generic);
    expect(unhideErrorText(new TypeError('Failed to fetch'))).toEqual(generic);
  });
});

describe('hiddenTodayHref', () => {
  it('builds the page link with an encoded cursor', () => {
    expect(hiddenTodayHref(null)).toBe('/hidden-today');
    expect(hiddenTodayHref({ before: '2026-10-16T10:00:00.000+02:00', beforeId: 'x' })).toBe(
      '/hidden-today?before=2026-10-16T10%3A00%3A00.000%2B02%3A00&beforeId=x',
    );
  });
});

describe('unhide', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const O = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const H = '33333333-3333-4333-8333-333333333333';

  it('posts {} to the brand-scoped URL and returns the item', async () => {
    const calls: Array<[string, RequestInit]> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ item: item({ state: 'restored' }) }), { status: 200 });
    }) as typeof fetch;
    const r = await unhide(O, B, H);
    expect(r.state).toBe('restored');
    expect(calls[0]![0]).toBe(`/api/v1/orgs/${O}/brands/${B}/hidden-comments/${H}/unhide`);
    expect(calls[0]![1].method).toBe('POST');
    expect(calls[0]![1].body).toBe('{}');
  });

  it('rejects non-uuid ids without fetching', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    await expect(unhide('../x', B, H)).rejects.toThrow();
    await expect(unhide(O, B, 'nope')).rejects.toThrow();
    expect(called).toBe(false);
  });
});
