import { REASON_CODES } from '@feedbouncer/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POLL_LIMIT,
  POLL_MS,
  REVERSIBILITY_LABEL,
  STEP_LABEL,
  STEP_ORDER,
  conflictReason,
  hasPending,
  openConfirm,
  outcomeText,
  resolveReviewItem,
  sourceText,
  stepAvailability,
  stepIssues,
  templateCount,
  toggleStep,
  undoLogStep,
  undoText,
  worstCaseLength,
  type ActionCapabilitiesDto,
} from './actions';
import { apiFetch } from './api-client';

vi.mock('./api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));

const entry = (platform: string, supported: boolean, maxChars: number | null = null) => ({
  platform,
  connectionId: `${platform}-1`,
  supported,
  missingScopes: [],
  maxChars,
});

/** A Facebook Page and an Instagram account, or Instagram alone. */
const caps = (platforms: ('facebook' | 'instagram')[]): ActionCapabilitiesDto => {
  const on = (p: string, ok: boolean, max: number | null = null) =>
    platforms.includes(p as 'facebook') ? [entry(p, ok, max)] : [];
  return {
    steps: {
      flag_for_review: { platforms: [...on('facebook', true), ...on('instagram', true)] },
      private_reply: {
        platforms: [...on('facebook', true, 2000), ...on('instagram', true, 1000)],
      },
      auto_reply: { platforms: [...on('facebook', true, 8000), ...on('instagram', true, 2200)] },
      hide: { platforms: [...on('facebook', true), ...on('instagram', true)] },
      ban: { platforms: [...on('facebook', true), ...on('instagram', false)] },
      delete: { platforms: [...on('facebook', true), ...on('instagram', true)] },
    },
  };
};

describe('step labels', () => {
  it('uses the agreed copy', () => {
    expect(STEP_ORDER.map((t) => STEP_LABEL[t])).toEqual([
      'Flag for review',
      'Private reply',
      'Auto-reply',
      'Hide',
      'Ban author',
      'Delete',
    ]);
    expect(REVERSIBILITY_LABEL).toEqual({
      hide: 'Reversible',
      delete: 'Irreversible',
      ban: 'Hard to reverse (unban)',
      auto_reply: 'Partly reversible (reply can be deleted)',
      private_reply: 'Irreversible',
      flag_for_review: 'Reversible',
    });
  });
});

describe('stepAvailability', () => {
  it('drops a step no platform in scope supports', () => {
    expect(stepAvailability(caps(['instagram'])).ban.available).toBe(false);
  });

  it('flags the platform a partly supported step is missing on', () => {
    const a = stepAvailability(caps(['facebook', 'instagram']));
    expect(a.ban).toMatchObject({ available: true, unavailableOn: ['Instagram'] });
    expect(a.hide.unavailableOn).toEqual([]);
  });

  it('takes the smallest reply limit in scope', () => {
    const both = stepAvailability(caps(['facebook', 'instagram']));
    expect(both.auto_reply.maxChars).toBe(2200);
    expect(stepAvailability(caps(['facebook', 'instagram']), 'facebook').auto_reply.maxChars).toBe(
      8000,
    );
  });

  it('offers every step when no connection is in scope', () => {
    expect(stepAvailability(caps([])).ban).toMatchObject({ available: true, maxChars: null });
  });
});

describe('toggleStep', () => {
  it('adds destructive steps already confirmed and keeps execution order', () => {
    const v = toggleStep(toggleStep(toggleStep([], 'delete', true), 'hide', true), 'ban', true);
    expect(v.map((s) => s.type)).toEqual(['hide', 'ban', 'delete']);
    expect(v[2]).toEqual({ type: 'delete', confirmIrreversible: true });
    expect(v[1]).toEqual({ type: 'ban', confirmHardToReverse: true });
  });

  it('removes a step', () => {
    expect(toggleStep([{ type: 'hide' }], 'hide', false)).toEqual([]);
  });
});

describe('conflictReason', () => {
  it('names the conflicting step and the reason', () => {
    expect(conflictReason('auto_reply', [{ type: 'hide' }])).toBe(
      "Can't reply to a hidden comment. Remove Hide first.",
    );
    expect(conflictReason('hide', [{ type: 'auto_reply', template: 'hi' }])).toContain(
      'Remove Auto-reply',
    );
    expect(conflictReason('ban', [{ type: 'private_reply', template: 'hi' }])).not.toBeNull();
    expect(conflictReason('delete', [{ type: 'hide' }])).not.toBeNull();
  });

  it('allows pairs that do not conflict', () => {
    expect(conflictReason('flag_for_review', [{ type: 'hide' }])).toBeNull();
    expect(conflictReason('ban', [{ type: 'hide' }])).toBeNull();
  });
});

describe('templateCount', () => {
  it('counts every variable at its maximum, in code points', () => {
    expect(worstCaseLength('Hi {{author_name}}!')).toBe(3 + 50 + 1);
    expect(worstCaseLength('Hi {{author_name|short}}')).toBe(3 + 50);
    expect(worstCaseLength('😀😀')).toBe(2);
  });

  it('is over only above the limit', () => {
    expect(templateCount('x'.repeat(2200), 2200).over).toBe(false);
    expect(templateCount('x'.repeat(2201), 2200)).toEqual({ count: 2201, max: 2200, over: true });
    expect(templateCount('x'.repeat(5000), null).over).toBe(false);
  });
});

describe('stepIssues', () => {
  it('maps server issues to the step by index', () => {
    const issues = [
      { path: 'actions.1.template', message: 'unknown_variable' },
      { path: 'actions.1', message: 'reply_to_hidden_comment' },
      { path: 'actions.10', message: 'duplicate_step' },
    ];
    expect(stepIssues(issues, 0)).toEqual([]);
    expect(stepIssues(issues, 1)).toHaveLength(2);
  });
});

describe('outcomeText', () => {
  it('covers every reason code', () => {
    const fallback = outcomeText('failed', 'no_such_reason_code');
    for (const code of REASON_CODES) {
      expect(outcomeText('skipped', code), code).not.toBe(
        outcomeText('skipped', 'no_such_reason_code'),
      );
    }
    expect(fallback).toMatch(/^Failed: /);
  });

  it('reads as a status with an optional reason', () => {
    expect(outcomeText('succeeded', null)).toBe('Done');
    expect(outcomeText('skipped', 'already_hidden')).toBe('Skipped: already hidden');
    expect(outcomeText('pending', null)).toBe('Waiting to run');
  });
});

describe('polling', () => {
  it('polls every 5 seconds, at most 60 times, while a step is pending', () => {
    expect([POLL_MS, POLL_LIMIT]).toEqual([5000, 60]);
    expect(hasPending([{ status: 'succeeded' }, { status: 'pending' }])).toBe(true);
    expect(hasPending([{ status: 'failed' }])).toBe(false);
  });

  it('keeps polling while an undo is in progress', () => {
    expect(hasPending([{ status: 'succeeded', undoneAt: 'now', undoStatus: 'pending' }])).toBe(
      true,
    );
    expect(hasPending([{ status: 'succeeded', undoneAt: 'now', undoStatus: 'applied' }])).toBe(
      false,
    );
  });
});

describe('requests', () => {
  beforeEach(() => vi.mocked(apiFetch).mockClear());

  it('undoes a step with a POST to its undo path', async () => {
    await undoLogStep('/api/v1/orgs/o/brands/b', 's1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/orgs/o/brands/b/action-log/s1/undo', {
      method: 'POST',
      body: {},
    });
  });

  it('confirms only delete and ban, with the key the dialog was opened with', async () => {
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const dialog = openConfirm('i1', 'delete');
    const send = () =>
      resolveReviewItem(
        '/api/v1/orgs/o/brands/b',
        dialog.itemId,
        dialog.resolution,
        dialog.requestKey,
      );
    await Promise.all([send(), send()]);
    expect(uuid).toHaveBeenCalledTimes(1);
    const bodies = vi.mocked(apiFetch).mock.calls.map(([, init]) => init?.body);
    expect(bodies).toEqual([
      { resolution: 'delete', requestKey: dialog.requestKey, confirm: true },
      { resolution: 'delete', requestKey: dialog.requestKey, confirm: true },
    ]);

    vi.mocked(apiFetch).mockClear();
    await resolveReviewItem('/api/v1/orgs/o/brands/b', 'i1', 'hide', 'k');
    expect(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body).toEqual({
      resolution: 'hide',
      requestKey: 'k',
    });
  });

  it('opens a new key for each dialog', () => {
    expect(openConfirm('i', 'ban').requestKey).not.toBe(openConfirm('i', 'ban').requestKey);
  });
});

describe('sourceText', () => {
  it('names who flagged the comment, with the rule name when there is one', () => {
    expect(sourceText('rule', 'No spam')).toBe('Rule: No spam');
    expect(sourceText('action_step', 'No spam')).toBe('Rule: No spam');
    expect(sourceText('classifier', null)).toBe('Classifier');
    expect(sourceText('user', null)).toBe('Flagged by a person');
    expect(sourceText('something_else', null)).toBe('Flagged');
  });
});

describe('undoText', () => {
  it('says how the undo went', () => {
    expect(undoText({ undoneAt: null, undoStatus: null })).toBeNull();
    expect(undoText({ undoneAt: 't', undoStatus: null })).toBe('Undone');
    expect(undoText({ undoneAt: 't', undoStatus: 'applied' })).toBe('Undone');
    expect(undoText({ undoneAt: 't', undoStatus: 'noop' })).toBe('Undone');
    expect(undoText({ undoneAt: 't', undoStatus: 'pending' })).toBe('Undo in progress');
    expect(undoText({ undoneAt: 't', undoStatus: 'failed' })).toBe('Undo failed. Try again.');
    expect(undoText({ undoneAt: null, undoStatus: 'not_eligible' })).toBe(
      'Undo failed. Try again.',
    );
  });
});
