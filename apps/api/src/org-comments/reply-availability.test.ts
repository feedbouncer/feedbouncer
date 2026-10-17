import { describe, expect, it } from 'vitest';
import type { ReplyTarget } from '@feedbouncer/actions';
import type { ConnectorCapabilities } from '@feedbouncer/connectors';
import { replyAvailability } from './reply-availability.js';

const now = new Date('2026-10-17T10:00:00Z');
const postedAt = new Date('2026-10-17T09:00:00Z');

const caps = (o: Partial<ConnectorCapabilities> = {}): ConnectorCapabilities =>
  ({
    actions: ['hide', 'unhide', 'delete'],
    responses: ['public_reply', 'private_reply'],
    constraints: { maxReplyChars: { public_reply: 2200 } },
    ...o,
  }) as unknown as ConnectorCapabilities;

const target = (o: Partial<ReplyTarget> = {}): ReplyTarget => ({
  connectionStatus: 'active',
  hasAuthor: true,
  parentExternalId: null,
  targetPlatformState: 'visible',
  ...o,
});

const run = (o: {
  permitted?: boolean;
  target?: ReplyTarget;
  caps?: ConnectorCapabilities | undefined;
}) =>
  replyAvailability({
    permitted: o.permitted ?? true,
    target: o.target ?? target(),
    postedAt,
    caps: 'caps' in o ? o.caps : caps(),
    now,
  });

describe('replyAvailability', () => {
  it('not_permitted wins over reconnect', () => {
    expect(
      run({ permitted: false, target: target({ connectionStatus: 'reconnect_required' }) }),
    ).toEqual({ available: false, reason: 'not_permitted' });
  });

  it('reconnect_required → connection_needs_reconnect', () => {
    expect(
      run({ target: target({ connectionStatus: 'reconnect_required' }), caps: undefined }),
    ).toEqual({
      available: false,
      reason: 'connection_needs_reconnect',
    });
  });

  it('paused → connection_inactive', () => {
    expect(run({ target: target({ connectionStatus: 'paused' }) })).toEqual({
      available: false,
      reason: 'connection_inactive',
    });
  });

  it('no caps → unsupported', () => {
    expect(run({ caps: undefined })).toEqual({ available: false, reason: 'unsupported' });
  });

  it('caps without public_reply → unsupported', () => {
    expect(run({ caps: caps({ responses: ['private_reply'] }) })).toEqual({
      available: false,
      reason: 'unsupported',
    });
  });

  it('hidden parent with publicReplyOnHidden false → reply_to_hidden_comment', () => {
    const noHidden = caps({ constraints: { publicReplyOnHidden: false } });
    expect(
      run({
        caps: noHidden,
        target: target({ parentExternalId: 'p1', targetPlatformState: 'hidden' }),
      }),
    ).toEqual({ available: false, reason: 'reply_to_hidden_comment' });
    // A parent that is not stored is treated as possibly hidden.
    expect(
      run({
        caps: noHidden,
        target: target({ parentExternalId: 'p1', targetPlatformState: null }),
      }),
    ).toEqual({ available: false, reason: 'reply_to_hidden_comment' });
    // Where replying under a hidden comment is allowed, it does not matter.
    expect(
      run({ target: target({ parentExternalId: 'p1', targetPlatformState: 'hidden' }) }),
    ).toEqual({ available: true, maxChars: 2200 });
  });

  it('a parent deleted on the platform → comment_gone', () => {
    expect(
      run({ target: target({ parentExternalId: 'p1', targetPlatformState: 'deleted' }) }),
    ).toEqual({ available: false, reason: 'comment_gone' });
  });

  it("ok → maxChars from the connector's constraints", () => {
    expect(run({})).toEqual({ available: true, maxChars: 2200 });
    expect(run({ caps: caps({ constraints: {} }) })).toEqual({ available: true, maxChars: 8000 });
  });
});
