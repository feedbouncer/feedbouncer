import { describe, expect, it } from 'vitest';
import { draftStatus, newDraft, replyDraft, type Draft, type DraftEvent } from './reply-draft';

function keys() {
  let n = 0;
  return () => `k${++n}`;
}

/** Applies events in order with one key source. */
function run(events: DraftEvent[], start?: Draft) {
  const key = keys();
  let d = start ?? newDraft(key);
  for (const e of events) d = replyDraft(d, e, key);
  return d;
}

describe('replyDraft', () => {
  it('replyDraft: network error keeps the key; edit rotates it', () => {
    const key = keys();
    let d = replyDraft(newDraft(key), { type: 'edit', text: 'Thanks!' }, key);
    const first = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    expect(d.phase).toBe('sending');
    d = replyDraft(d, { type: 'network_error' }, key);
    // The first send may have reached the server: the retry must replay the same key.
    expect(d.requestKey).toBe(first);
    expect(d.text).toBe('Thanks!');
    expect(d.phase).toBe('editing');
    expect(d.reason).toBe('network_error');
    d = replyDraft(d, { type: 'send' }, key);
    expect(d.requestKey).toBe(first);
    d = replyDraft(d, { type: 'network_error' }, key);
    // Changing the text makes it a different reply, so it gets a new key.
    d = replyDraft(d, { type: 'edit', text: 'Thanks a lot!' }, key);
    expect(d.requestKey).not.toBe(first);
    expect(d.reason).toBeNull();
  });

  it('send → sending; accepted pending → pending; polled applied → sent, text "" and new key', () => {
    const key = keys();
    let d = replyDraft(newDraft(key), { type: 'edit', text: 'Hi' }, key);
    const k = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    expect(d.phase).toBe('sending');
    d = replyDraft(
      d,
      { type: 'accepted', actionId: 'a1', status: 'pending', outcomeCode: null },
      key,
    );
    expect(d).toMatchObject({ phase: 'pending', actionId: 'a1', requestKey: k, text: 'Hi' });
    // A poll that is still pending changes nothing.
    expect(replyDraft(d, { type: 'polled', status: 'pending', outcomeCode: null }, key)).toEqual(d);
    d = replyDraft(d, { type: 'polled', status: 'applied', outcomeCode: null }, key);
    expect(d.phase).toBe('sent');
    expect(d.text).toBe('');
    expect(d.requestKey).not.toBe(k);
    expect(d.actionId).toBeNull();
  });

  it('accepted applied straight away → sent', () => {
    const d = run([
      { type: 'edit', text: 'Hi' },
      { type: 'send' },
      { type: 'accepted', actionId: 'a1', status: 'applied', outcomeCode: null },
    ]);
    expect(d).toMatchObject({ phase: 'sent', text: '' });
  });

  it('polled failed → failed, text kept, new key, reason', () => {
    const key = keys();
    let d = run([{ type: 'edit', text: 'Hi' }]);
    const k = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    d = replyDraft(
      d,
      { type: 'accepted', actionId: 'a1', status: 'pending', outcomeCode: null },
      key,
    );
    d = replyDraft(d, { type: 'polled', status: 'failed', outcomeCode: 'retries_exhausted' }, key);
    expect(d).toMatchObject({ phase: 'failed', text: 'Hi', reason: 'retries_exhausted' });
    expect(d.requestKey).not.toBe(k);
    const ne = run([
      { type: 'edit', text: 'Hi' },
      { type: 'send' },
      {
        type: 'accepted',
        actionId: 'a1',
        status: 'not_eligible',
        outcomeCode: 'reply_to_hidden_comment',
      },
    ]);
    expect(ne).toMatchObject({ phase: 'failed', text: 'Hi', reason: 'reply_to_hidden_comment' });
  });

  it('refused text_too_long keeps text, new key', () => {
    const key = keys();
    let d = replyDraft(newDraft(key), { type: 'edit', text: 'x'.repeat(9000) }, key);
    const k = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    d = replyDraft(d, { type: 'refused', code: 'text_too_long', max: 8000 }, key);
    expect(d).toMatchObject({ phase: 'failed', text: 'x'.repeat(9000), reason: 'text_too_long' });
    expect(d.requestKey).not.toBe(k);
  });

  it('403 forbidden → not_permitted state, text kept', () => {
    const key = keys();
    let d = replyDraft(newDraft(key), { type: 'edit', text: 'Thanks' }, key);
    const k = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    d = replyDraft(d, { type: 'refused', code: 'forbidden' }, key);
    expect(d).toMatchObject({ phase: 'not_permitted', text: 'Thanks' });
    expect(d.requestKey).not.toBe(k);
    // Without the permission, neither typing nor sending moves it on.
    expect(replyDraft(d, { type: 'send' }, key)).toEqual(d);
    expect(replyDraft(d, { type: 'edit', text: 'x' }, key)).toEqual(d);
  });

  it('noop comment_gone → gone', () => {
    for (const code of ['comment_gone', 'already_deleted']) {
      const d = run([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'accepted', actionId: 'a1', status: 'pending', outcomeCode: null },
        { type: 'polled', status: 'noop', outcomeCode: code },
      ]);
      expect(d.phase).toBe('gone');
    }
    // A refused request for a comment that is no longer in the workspace is reported as not sent.
    const nf = run([
      { type: 'edit', text: 'Hi' },
      { type: 'send' },
      { type: 'refused', code: 'not_found' },
    ]);
    expect(nf).toMatchObject({ phase: 'failed', reason: 'comment_gone', text: 'Hi' });
  });

  it('gave_up → stalled, key kept', () => {
    const key = keys();
    let d = replyDraft(newDraft(key), { type: 'edit', text: 'Hi' }, key);
    const k = d.requestKey;
    d = replyDraft(d, { type: 'send' }, key);
    d = replyDraft(
      d,
      { type: 'accepted', actionId: 'a1', status: 'pending', outcomeCode: null },
      key,
    );
    d = replyDraft(d, { type: 'gave_up' }, key);
    expect(d).toMatchObject({ phase: 'stalled', requestKey: k, text: 'Hi' });
    // Sending again replays the same request, so it asks about the same reply.
    expect(replyDraft(d, { type: 'send' }, key)).toMatchObject({ phase: 'sending', requestKey: k });
  });

  it('ignores edits and sends while a request is in flight', () => {
    const d = run([{ type: 'edit', text: 'Hi' }, { type: 'send' }]);
    const key = keys();
    expect(replyDraft(d, { type: 'edit', text: 'other' }, key)).toEqual(d);
    expect(replyDraft(d, { type: 'send' }, key)).toEqual(d);
  });
});

describe('draftStatus', () => {
  const at = (events: DraftEvent[]) => draftStatus(run(events), 'instagram');

  it('uses the exact copy for each phase', () => {
    expect(at([])).toBeNull();
    expect(at([{ type: 'edit', text: 'Hi' }, { type: 'send' }])).toEqual({
      text: 'Sending…',
      alert: false,
    });
    expect(
      at([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'accepted', actionId: 'a', status: 'applied', outcomeCode: null },
      ]),
    ).toEqual({ text: 'Reply sent.', alert: false });
    expect(
      at([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'accepted', actionId: 'a', status: 'failed', outcomeCode: 'retries_exhausted' },
      ]),
    ).toEqual({
      text: 'Reply not sent: it kept failing after several tries',
      alert: true,
      retry: true,
    });
    expect(
      at([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'refused', code: 'text_too_long' },
      ]),
    ).toEqual({
      text: 'Reply not sent: Reply is too long for this platform.',
      alert: true,
      retry: true,
    });
    expect(
      at([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'accepted', actionId: 'a', status: 'pending', outcomeCode: null },
        { type: 'gave_up' },
      ]),
    ).toEqual({ text: 'Still sending. Check back in a minute.', alert: false });
    expect(
      at([
        { type: 'edit', text: 'Hi' },
        { type: 'send' },
        { type: 'accepted', actionId: 'a', status: 'noop', outcomeCode: 'comment_gone' },
      ]),
    ).toEqual({ text: 'This comment was deleted on Instagram.', alert: true });
    expect(
      at([{ type: 'edit', text: 'Hi' }, { type: 'send' }, { type: 'refused', code: 'forbidden' }]),
    ).toEqual({
      text: "You don't have permission to reply. Ask an owner or admin.",
      alert: true,
    });
    expect(at([{ type: 'edit', text: 'Hi' }, { type: 'send' }, { type: 'network_error' }])).toEqual(
      {
        text: "Couldn't reach FeedBouncer. Check your connection and try again.",
        alert: true,
      },
    );
  });
});
