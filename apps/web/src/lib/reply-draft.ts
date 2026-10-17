// One reply being written in the Comments list, kept free of React so it can be tested directly.
// The request key belongs to the draft: it is kept across a network error or a slow delivery, so
// sending again replays the same request and the API posts at most one reply. Any change to the
// text, a refusal or a final outcome makes it a new request with a new key.
import { platformLabel } from './actions';
import { isOutcomeCode, messageFor, outcomeText } from './messages';
import { reasonText } from './moderation';

export type DraftPhase =
  | 'editing'
  | 'sending'
  | 'pending'
  | 'sent'
  | 'failed'
  | 'stalled'
  | 'gone'
  | 'not_permitted';

export interface Draft {
  text: string;
  requestKey: string;
  phase: DraftPhase;
  /** The reply being delivered, while pending. */
  actionId: string | null;
  /** An outcome or error code explaining the phase, or `network_error`. */
  reason: string | null;
}

export type DraftEvent =
  | { type: 'edit'; text: string }
  | { type: 'send' }
  | { type: 'network_error' }
  /** The API refused the request itself (HTTP 4xx). */
  | { type: 'refused'; code: string; max?: number }
  | { type: 'accepted'; actionId: string; status: string; outcomeCode: string | null }
  | { type: 'polled'; status: string; outcomeCode: string | null }
  | { type: 'gave_up' };

const GONE = new Set(['comment_gone', 'already_deleted']);

export function newDraft(newKey: () => string): Draft {
  return { text: '', requestKey: newKey(), phase: 'editing', actionId: null, reason: null };
}

export const isInFlight = (d: Draft): boolean => d.phase === 'sending' || d.phase === 'pending';

/** Phases where the text can change or be sent. */
const OPEN: ReadonlySet<DraftPhase> = new Set(['editing', 'sent', 'failed', 'stalled']);

/** The draft after the API reported a status for its reply. */
function settle(d: Draft, status: string, outcomeCode: string | null, newKey: () => string): Draft {
  switch (status) {
    case 'pending':
      return d;
    case 'applied':
      return { text: '', requestKey: newKey(), phase: 'sent', actionId: null, reason: null };
    case 'noop':
      if (outcomeCode !== null && GONE.has(outcomeCode))
        return { ...d, requestKey: newKey(), phase: 'gone', actionId: null, reason: outcomeCode };
      break;
  }
  // failed, not_eligible, any other noop: never shown as sent; the text stays for another try.
  return {
    ...d,
    requestKey: newKey(),
    phase: 'failed',
    actionId: null,
    reason: outcomeCode ?? 'failed',
  };
}

export function replyDraft(d: Draft, e: DraftEvent, newKey: () => string): Draft {
  switch (e.type) {
    case 'edit':
      if (!OPEN.has(d.phase)) return d;
      return {
        text: e.text,
        requestKey: e.text === d.text ? d.requestKey : newKey(),
        phase: 'editing',
        actionId: null,
        reason: null,
      };
    case 'send':
      return OPEN.has(d.phase) ? { ...d, phase: 'sending', actionId: null, reason: null } : d;
    case 'network_error':
      // The request may have reached the server: keep the key so a retry replays it.
      return d.phase === 'sending' ? { ...d, phase: 'editing', reason: 'network_error' } : d;
    case 'refused':
      if (d.phase !== 'sending') return d;
      if (e.code === 'forbidden')
        return { ...d, requestKey: newKey(), phase: 'not_permitted', reason: 'not_permitted' };
      return {
        ...d,
        requestKey: newKey(),
        phase: 'failed',
        // The comment is no longer in this workspace (deleted, or its brand archived).
        reason: e.code === 'not_found' ? 'comment_gone' : e.code,
      };
    case 'accepted':
      if (d.phase !== 'sending') return d;
      return e.status === 'pending'
        ? { ...d, phase: 'pending', actionId: e.actionId }
        : settle(d, e.status, e.outcomeCode, newKey);
    case 'polled':
      return d.phase === 'pending' ? settle(d, e.status, e.outcomeCode, newKey) : d;
    case 'gave_up':
      return d.phase === 'pending' ? { ...d, phase: 'stalled', actionId: null } : d;
  }
}

export interface DraftStatus {
  text: string;
  alert: boolean;
  /** Offer `Try again`, which sends the kept text as a new request. */
  retry?: true;
}

/** The status line under the composer; null when there is nothing to say. */
export function draftStatus(d: Draft, platform: string): DraftStatus | null {
  switch (d.phase) {
    case 'editing':
      return d.reason === 'network_error'
        ? { text: "Couldn't reach FeedBouncer. Check your connection and try again.", alert: true }
        : null;
    case 'sending':
    case 'pending':
      return { text: 'Sending…', alert: false };
    case 'sent':
      return { text: 'Reply sent.', alert: false };
    case 'stalled':
      return { text: 'Still sending. Check back in a minute.', alert: false };
    case 'gone':
      return { text: `This comment was deleted on ${platformLabel(platform)}.`, alert: true };
    case 'not_permitted':
      return { text: reasonText('not_permitted', platform), alert: true };
    case 'failed': {
      const code = d.reason ?? 'failed';
      const why = isOutcomeCode(code) ? outcomeText(code, platform) : messageFor(code);
      return { text: `Reply not sent: ${why}`, alert: true, retry: true };
    }
  }
}
