import { SUGGESTION_REASONS, SUGGESTION_STATUSES } from '@feedbouncer/actions/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bannerText,
  bulkByAuthor,
  bulkByIds,
  decide,
  endReviewModeBody,
  formatLocal,
  formatLocalExact,
  handledText,
  openDecision,
  singleFlight,
  suggestionStatusText,
  type ReviewModeStatusDto,
  type SuggestionView,
} from './review-mode';

const fmt = (iso: string) => `<${iso}>`;

const status = (over: Partial<ReviewModeStatusDto> = {}): ReviewModeStatusDto => ({
  connectionId: 'c1',
  platform: 'facebook',
  displayName: 'Shop Page',
  state: 'active',
  startedAt: '2026-10-20T10:00:00.000Z',
  endsAt: '2026-10-27T10:00:00.000Z',
  endedAt: null,
  graceEndsAt: '2026-10-30T10:00:00.000Z',
  pendingCount: 3,
  ...over,
});

const suggestion = (over: Partial<SuggestionView> = {}): SuggestionView => ({
  id: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  platform: 'facebook',
  commentId: 'cm1',
  commentBody: 'buy now',
  authorId: '33333333-3333-4333-8333-333333333333',
  authorName: 'Sam',
  authorPendingCount: 2,
  status: 'pending',
  statusReason: null,
  createdAt: '2026-10-21T10:00:00.000Z',
  decidedAt: null,
  decidedByName: null,
  expiresAt: null,
  sources: [],
  plan: { steps: [{ type: 'hide' }], dropped: [] },
  execution: null,
  ...over,
});

function mockFetch(status = 200, body: unknown = { status: 'approved' }) {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
    await Promise.resolve();
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const sent = (f: ReturnType<typeof mockFetch>, i = 0) => ({
  url: f.mock.calls[i]![0],
  body: JSON.parse(String(f.mock.calls[i]![1].body)) as Record<string, unknown>,
});

afterEach(() => vi.unstubAllGlobals());

const BASE = '/api/v1/orgs/o/brands/b' as const;

describe('formatLocalExact', () => {
  it('spells out the full date and time with the zone', () => {
    const t = formatLocalExact('2026-10-27T10:04:05.000Z', {
      timeZone: 'Europe/Berlin',
      locale: 'en-US',
    });
    expect(t).toContain('Tuesday, October 27, 2026');
    expect(t).toContain('11:04:05');
    expect(formatLocalExact('nope')).toBe('');
  });
});

describe('formatLocal', () => {
  it('shows window start and end across Berlin DST', () => {
    const o = { timeZone: 'Europe/Berlin', locale: 'en-GB' };
    expect(formatLocal('2026-10-20T10:00:00.000Z', o)).toContain('12:00');
    expect(formatLocal('2026-10-27T10:00:00.000Z', o)).toContain('11:00');
    expect(formatLocal('2026-10-27T10:00:00.000Z', o)).toContain('27 Oct 2026');
  });

  it('shows window start and end across the New York change on 2026-11-01', () => {
    const o = { timeZone: 'America/New_York', locale: 'en-US' };
    const start = formatLocal('2026-10-28T14:00:00.000Z', o);
    const end = formatLocal('2026-11-04T14:00:00.000Z', o);
    expect(start).toContain('10:00');
    expect(start).toContain('EDT');
    expect(end).toContain('9:00');
    expect(end).toContain('EST');
    expect(end).toContain('Nov 4, 2026');
  });
});

describe('bannerText', () => {
  it('active returns the exact copy', () => {
    expect(bannerText(status(), fmt)).toBe(
      "Review mode is on for Shop Page until <2026-10-27T10:00:00.000Z>. FeedBouncer suggests actions but won't hide, delete, ban or reply on its own. 3 suggestions are waiting for review.",
    );
  });

  it('ended with pending returns the exact copy, using endsAt after a natural end', () => {
    expect(bannerText(status({ state: 'ended' }), fmt)).toBe(
      'Review mode ended on <2026-10-27T10:00:00.000Z>. Rules now run automatically. 3 suggestions from review mode were not run and will expire on <2026-10-30T10:00:00.000Z> unless you review them.',
    );
  });

  it('ended early uses endedAt', () => {
    const s = status({
      state: 'ended_early',
      endedAt: '2026-10-22T08:00:00.000Z',
      graceEndsAt: '2026-10-25T08:00:00.000Z',
    });
    expect(bannerText(s, fmt)).toBe(
      'Review mode ended on <2026-10-22T08:00:00.000Z>. Rules now run automatically. 3 suggestions from review mode were not run and will expire on <2026-10-25T08:00:00.000Z> unless you review them.',
    );
  });

  it('returns null for off, opted_out and ended with nothing pending', () => {
    expect(bannerText(status({ state: 'off' }), fmt)).toBeNull();
    expect(bannerText(status({ state: 'opted_out' }), fmt)).toBeNull();
    expect(bannerText(status({ state: 'ended', pendingCount: 0 }), fmt)).toBeNull();
    expect(bannerText(status({ state: 'ended_early', pendingCount: 0 }), fmt)).toBeNull();
  });

  it('names an unnamed account', () => {
    expect(bannerText(status({ displayName: null }), fmt)).toContain(
      'Review mode is on for Unnamed account until',
    );
  });
});

describe('suggestionStatusText', () => {
  it('covers every SUGGESTION_STATUSES × reason', () => {
    for (const s of SUGGESTION_STATUSES) {
      for (const reason of [null, ...SUGGESTION_REASONS]) {
        const text = suggestionStatusText(
          suggestion({
            status: s,
            statusReason: reason,
            decidedAt: '2026-10-22T09:00:00.000Z',
            decidedByName: 'Ana',
          }),
          fmt,
        );
        expect(text.length, `${s}/${reason}`).toBeGreaterThan(0);
      }
    }
  });

  it('uses the exact copy for not applicable, expired and withdrawn', () => {
    const t = (status: SuggestionView['status'], statusReason: string | null) =>
      suggestionStatusText(suggestion({ status, statusReason }), fmt);
    expect(t('not_applicable', 'comment_gone')).toBe(
      'No longer applicable: the comment was deleted.',
    );
    expect(t('not_applicable', 'comment_edited')).toBe(
      'No longer applicable: the comment was edited after this suggestion was made.',
    );
    expect(t('expired', 'grace_period_ended')).toBe(
      'Expired: not reviewed within 72 hours after review mode ended. Nothing was run.',
    );
    expect(t('withdrawn', 'rule_changed')).toBe(
      'Withdrawn: the rule behind this suggestion was changed or turned off.',
    );
  });

  it('names who decided, and explains a dismissal by early exit', () => {
    const decided = { decidedAt: '2026-10-22T09:00:00.000Z', decidedByName: 'Ana' };
    expect(suggestionStatusText(suggestion({ status: 'approved', ...decided }), fmt)).toBe(
      'Approved by Ana at <2026-10-22T09:00:00.000Z>.',
    );
    expect(suggestionStatusText(suggestion({ status: 'dismissed', ...decided }), fmt)).toBe(
      'Dismissed by Ana at <2026-10-22T09:00:00.000Z>.',
    );
    expect(
      suggestionStatusText(
        suggestion({ status: 'dismissed', statusReason: 'review_mode_ended', ...decided }),
        fmt,
      ),
    ).toBe('Dismissed by Ana at <2026-10-22T09:00:00.000Z> when review mode was ended early.');
  });
});

describe('handledText', () => {
  it('uses the exact already-handled copy', () => {
    expect(
      handledText(
        { status: 'approved', decidedAt: '2026-10-22T09:00:00.000Z', decidedByName: 'Ana' },
        fmt,
      ),
    ).toBe('Already handled by Ana at <2026-10-22T09:00:00.000Z>.');
  });

  it('explains a suggestion the system closed instead of naming a team member', () => {
    const h = (status: string) =>
      handledText({ status, decidedAt: null, decidedByName: null }, fmt);
    expect(h('expired')).toBe(
      'Expired: not reviewed within 72 hours after review mode ended. Nothing was run.',
    );
    expect(h('withdrawn')).toBe(
      'Withdrawn: the rule behind this suggestion was changed or turned off.',
    );
    expect(h('not_applicable')).toBe(
      'No longer applicable: the comment was deleted or edited after this suggestion was made.',
    );
  });
});

describe('decisions', () => {
  it('approve of a delete plan asks for confirmation and sends one requestKey across a double click', async () => {
    const f = mockFetch();
    const d = openDecision(
      suggestion({ plan: { steps: [{ type: 'delete', confirmIrreversible: true }], dropped: [] } }),
      'approve',
    );
    expect(d.confirm).toBe(true);
    const submit = singleFlight(() => decide(BASE, d).then(() => undefined));
    await Promise.all([submit(), submit()]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sent(f)).toEqual({
      url: `${BASE}/suggestions/${d.suggestionId}/approve`,
      body: { requestKey: d.requestKey, confirm: true },
    });
    await submit();
    expect(sent(f, 1).body.requestKey).toBe(d.requestKey);
  });

  it('a hide plan or a dismissal needs no confirmation and sends no confirm flag', async () => {
    const f = mockFetch(200, { status: 'dismissed' });
    expect(openDecision(suggestion(), 'approve').confirm).toBe(false);
    const ban = suggestion({
      plan: { steps: [{ type: 'ban', confirmHardToReverse: true }], dropped: [] },
    });
    expect(openDecision(ban, 'approve').confirm).toBe(true);
    const d = openDecision(ban, 'dismiss');
    expect(d.confirm).toBe(false);
    await decide(BASE, d);
    expect(sent(f)).toEqual({
      url: `${BASE}/suggestions/${d.suggestionId}/dismiss`,
      body: { requestKey: d.requestKey },
    });
  });

  it('shows already-handled message on 409', async () => {
    mockFetch(409, {
      error: {
        code: 'suggestion_already_handled',
        message: 'x',
        handled: {
          status: 'approved',
          decidedAt: '2026-10-22T09:00:00.000Z',
          decidedByName: 'Ana',
        },
      },
    });
    const err = await decide(BASE, openDecision(suggestion(), 'approve')).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 409,
      code: 'suggestion_already_handled',
      handled: { decidedByName: 'Ana' },
    });
  });

  it('bulk approve sends selected ids', async () => {
    const f = mockFetch(200, { results: [] });
    await bulkByIds(BASE, 'approve', ['a', 'b'], 'k1', true);
    expect(sent(f)).toEqual({
      url: `${BASE}/suggestions/bulk`,
      body: { action: 'approve', ids: ['a', 'b'], requestKey: 'k1', confirm: true },
    });
    await bulkByIds(BASE, 'dismiss', ['a'], 'k2', false);
    expect(sent(f, 1).body).toEqual({ action: 'dismiss', ids: ['a'], requestKey: 'k2' });
  });

  it('author bulk sends connectionId and authorId filter', async () => {
    const f = mockFetch(202, { matched: 4 });
    const res = await bulkByAuthor(BASE, 'approve', 'conn', 'auth', 'k3');
    expect(res).toEqual({ matched: 4 });
    expect(sent(f).body).toEqual({
      action: 'approve',
      connectionId: 'conn',
      filter: { authorId: 'auth' },
      requestKey: 'k3',
      confirm: true,
    });
    await bulkByAuthor(BASE, 'dismiss', 'conn', 'auth', 'k4');
    expect(sent(f, 1).body).toEqual({
      action: 'dismiss',
      connectionId: 'conn',
      filter: { authorId: 'auth' },
      requestKey: 'k4',
    });
  });
});

describe('endReviewModeBody', () => {
  it('requires confirm for approve-all', () => {
    expect(endReviewModeBody('leave', false)).toEqual({ pending: 'leave' });
    expect(endReviewModeBody('dismiss', false)).toEqual({ pending: 'dismiss' });
    expect(endReviewModeBody('approve', false)).toBeNull();
    expect(endReviewModeBody('approve', true)).toEqual({ pending: 'approve', confirm: true });
  });
});
