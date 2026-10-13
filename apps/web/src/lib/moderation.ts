// The moderation-action logic behind CommentActions, kept free of React so it
// can be tested directly. The API decides what is available (and why not);
// this module only presents its answer and tracks one request's progress.
import { messageFor, outcomeSentence, outcomeText } from './messages';
import { PLATFORM_COPY, isConnectable } from './platforms';

export type ActionKind =
  | 'hide'
  | 'unhide'
  | 'delete'
  | 'ban_author'
  | 'unban_author'
  | 'public_reply'
  | 'private_reply';
export type ReplyKind = 'public_reply' | 'private_reply';
export type ActionStatus = 'pending' | 'applied' | 'noop' | 'not_eligible' | 'failed';
export type CommentState = 'visible' | 'hidden' | 'deleted';

export type ActionAvailability = { available: true } | { available: false; reason: string };
export type Availability = Record<ActionKind, ActionAvailability>;
export type ReplyLimits = Record<ReplyKind, number>;

export interface ShownAction<K extends ActionKind = ActionKind> {
  kind: K;
  available: boolean;
  /** An outcome code explaining why it is unavailable. */
  reason: string | null;
}

const shown = <K extends ActionKind>(kind: K, a: ActionAvailability): ShownAction<K> | null => {
  if (a.available) return { kind, available: true, reason: null };
  // The platform has no such action at all: offer nothing.
  if (a.reason === 'unsupported') return null;
  return { kind, available: false, reason: a.reason };
};

const present = <T>(v: T | null): v is T => v !== null;

/** The buttons and reply forms to show, in display order. */
export function shownActions(
  state: CommentState,
  availability: Availability,
): { buttons: ShownAction[]; replies: ShownAction<ReplyKind>[] } {
  const toggle: ActionKind = state === 'hidden' ? 'unhide' : 'hide';
  const kinds: ActionKind[] = [toggle, 'delete', 'ban_author', 'unban_author'];
  const replies: ReplyKind[] = ['public_reply', 'private_reply'];
  return {
    buttons: kinds.map((k) => shown(k, availability[k])).filter(present),
    replies: replies.map((k) => shown(k, availability[k])).filter(present),
  };
}

/** Text for an unavailable action, from the outcome texts. */
export function reasonText(reason: string, platform: string): string {
  return outcomeSentence(reason, platform);
}

/** Length as the API counts it: code points, so an emoji is one. */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function replyCheck(
  text: string,
  max: number,
): { count: number; max: number; over: boolean; canSubmit: boolean } {
  const count = codePointLength(text);
  const over = count > max;
  return { count, max, over, canSubmit: !over && text.trim() !== '' };
}

export function deleteConfirmText(platform: string): string {
  return isConnectable(platform)
    ? PLATFORM_COPY[platform].deleteConfirm
    : "Delete this comment? This can't be undone.";
}

/** Asks before deleting; the delete runs only when this returns true. */
export function confirmDelete(platform: string, ask: (message: string) => boolean): boolean {
  return ask(deleteConfirmText(platform));
}

export interface ActionSnapshot {
  id: string;
  status: ActionStatus;
  outcomeCode: string | null;
}

export type Progress =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'pending'; actionId: string }
  /** Polling stopped while the action was still pending. */
  | { phase: 'unconfirmed' }
  | { phase: 'done'; status: Exclude<ActionStatus, 'pending'>; outcomeCode: string | null }
  | { phase: 'error'; message: string };

export type ProgressEvent =
  | { type: 'submit' }
  | { type: 'accepted'; action: ActionSnapshot }
  | { type: 'polled'; actions: readonly ActionSnapshot[] }
  | { type: 'gave_up' }
  | { type: 'rejected'; message: string };

const settled = (a: ActionSnapshot): Progress =>
  a.status === 'pending'
    ? { phase: 'pending', actionId: a.id }
    : { phase: 'done', status: a.status, outcomeCode: a.outcomeCode };

/** A request's progress only moves past pending on the API's own status. */
export function progress(prev: Progress, ev: ProgressEvent): Progress {
  switch (ev.type) {
    case 'submit':
      return { phase: 'submitting' };
    case 'accepted':
      return settled(ev.action);
    case 'rejected':
      return { phase: 'error', message: ev.message };
    case 'polled': {
      if (prev.phase !== 'pending') return prev;
      const a = ev.actions.find((x) => x.id === prev.actionId);
      return a && a.status !== 'pending' ? settled(a) : prev;
    }
    case 'gave_up':
      return prev.phase === 'pending' ? { phase: 'unconfirmed' } : prev;
  }
}

export const isBusy = (p: Progress): boolean => p.phase === 'submitting' || p.phase === 'pending';

export function progressText(
  p: Progress,
  platform: string,
): { text: string; alert: boolean } | null {
  switch (p.phase) {
    case 'idle':
      return null;
    case 'submitting':
    case 'pending':
      return { text: 'Pending…', alert: false };
    case 'unconfirmed':
      return { text: 'Still pending. Refresh the page to check again.', alert: false };
    case 'error':
      return { text: p.message, alert: true };
    case 'done': {
      const code = p.outcomeCode ?? '';
      switch (p.status) {
        case 'applied':
          return { text: 'Done', alert: false };
        case 'noop':
          return { text: `No change needed: ${outcomeText(code, platform)}`, alert: false };
        case 'not_eligible':
          return { text: `Not eligible. ${outcomeSentence(code, platform)}`, alert: true };
        case 'failed':
          return { text: `Failed, try again. ${outcomeSentence(code, platform)}`, alert: true };
      }
    }
  }
}

/** Text for an API refusal of the request itself. */
export function rejectionText(code: string, max: number | undefined): string {
  const text = messageFor(code);
  return code === 'text_too_long' && max !== undefined
    ? `${text} The limit is ${max} characters.`
    : text;
}

/** One line of the action history. */
export function historyText(a: ActionSnapshot, platform: string): string {
  if (a.status === 'pending') return 'Pending…';
  if (a.status === 'failed') return `Failed. ${outcomeSentence(a.outcomeCode ?? '', platform)}`;
  const t = progressText({ phase: 'done', status: a.status, outcomeCode: a.outcomeCode }, platform);
  return t?.text ?? '';
}
