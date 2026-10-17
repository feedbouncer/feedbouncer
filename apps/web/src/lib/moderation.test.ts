import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  progress,
  progressText,
  reasonText,
  rejectionText,
  shownActions,
  type Availability,
} from './moderation';

const ok = { available: true } as const;
const all: Availability = {
  hide: ok,
  unhide: ok,
  delete: ok,
  ban_author: ok,
  unban_author: ok,
  public_reply: ok,
  private_reply: ok,
};

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('😀')).toBe(1);
    expect(codePointLength('שלום')).toBe(4);
  });
});

describe('shownActions', () => {
  it('offers unhide for a hidden comment and hide otherwise', () => {
    expect(shownActions('hidden', all).buttons.map((b) => b.kind)).toEqual([
      'unhide',
      'delete',
      'ban_author',
      'unban_author',
    ]);
    expect(shownActions('visible', all).buttons[0]?.kind).toBe('hide');
  });
  it('drops unsupported kinds and keeps other unavailable kinds with their reason', () => {
    const s = shownActions('visible', {
      ...all,
      ban_author: { available: false, reason: 'unsupported' },
      unban_author: { available: false, reason: 'unsupported' },
      private_reply: { available: false, reason: 'private_reply_already_sent' },
    });
    expect(s.buttons.map((b) => b.kind)).toEqual(['hide', 'delete']);
    expect(s.replies).toEqual([
      { kind: 'public_reply', available: true, reason: null },
      { kind: 'private_reply', available: false, reason: 'private_reply_already_sent' },
    ]);
  });
});

describe('progress', () => {
  it('records a request that was decided up front without polling', () => {
    const p = progress(
      { phase: 'submitting' },
      { type: 'accepted', action: { id: 'a', status: 'noop', outcomeCode: 'already_hidden' } },
    );
    expect(progressText(p, 'facebook')?.text).toBe('No change needed: already hidden');
  });
  it('ignores polls when nothing is pending', () => {
    const idle = { phase: 'idle' } as const;
    expect(
      progress(idle, {
        type: 'polled',
        actions: [{ id: 'a', status: 'applied', outcomeCode: null }],
      }),
    ).toBe(idle);
    expect(progressText(idle, 'facebook')).toBeNull();
  });
  it('describes a not-eligible result as a sentence', () => {
    const p = progress(
      { phase: 'pending', actionId: 'a' },
      {
        type: 'polled',
        actions: [{ id: 'a', status: 'not_eligible', outcomeCode: 'reply_too_long' }],
      },
    );
    expect(progressText(p, 'instagram')).toEqual({
      text: 'Not eligible. Reply is too long for this platform.',
      alert: true,
    });
  });
});

describe('rejectionText', () => {
  it('names the limit of an over-long reply', () => {
    expect(rejectionText('text_too_long', 2200)).toBe(
      'Reply is too long for this platform. The limit is 2200 characters.',
    );
  });
  it('falls back to the plain message', () => {
    expect(rejectionText('text_too_long', undefined)).toBe('Reply is too long for this platform.');
    expect(rejectionText('connection_inactive', 5)).toBe(
      'This connection is not active. Reconnect it and try again.',
    );
  });
});

describe('reasonText', () => {
  it('explains not_permitted', () => {
    expect(reasonText('not_permitted', 'facebook')).toBe(
      "You don't have permission to reply. Ask an owner or admin.",
    );
  });
});
