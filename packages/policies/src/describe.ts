import { MAX_INPUT_CHARS } from '@feedbouncer/classifier';
import type {
  Downgrade,
  PolicyAction,
  PolicyDecision,
  PolicyMatch,
  PolicyVerdict,
} from './types.js';

const VERB: Record<PolicyAction, string> = {
  flag: 'flag for review',
  hide: 'hide',
  remove: 'delete',
};
const DOWNGRADE: Record<Downgrade, string> = {
  low_confidence: 'possible match',
  low_signal: 'too little text to act on',
  moderator_acted: 'a moderator already acted on this comment',
};
const TRUNCATED = `Only the first ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters of the comment were checked.`;
const label = (m: PolicyMatch) => `“${m.name}” (revision ${m.revision})`;
const effect = (m: PolicyMatch) =>
  m.downgrade
    ? `${DOWNGRADE[m.downgrade]}, flagged for review instead of ${VERB[m.action]}`
    : VERB[m.effectiveAction];

/** Cut to at most `max` UTF-16 units without splitting a code point. */
function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const DECISION_MAX = 2000;
const PREVIEW_MAX = 500;

export function describeDecision(d: PolicyDecision, o: { truncated: boolean }): string {
  if (!d.winner) return 'No policy matched.';
  const note = o.truncated ? ` ${TRUNCATED}` : '';
  const head = `Matched policy ${label(d.winner)}: ${effect(d.winner)}.`;
  const others = d.matches
    .filter((m) => m.revisionId !== d.winner!.revisionId)
    .map((m) => `Also matched: ${label(m)} — ${effect(m)}.`);
  let body = head;
  let shown = 0;
  for (const line of others) {
    const remaining = others.length - shown - 1;
    const reserve = remaining > 0 ? ` and ${remaining} more.`.length : 0;
    if ((body + ' ' + line).length + reserve + note.length > DECISION_MAX) break;
    body += ` ${line}`;
    shown++;
  }
  const hidden = others.length - shown;
  if (hidden > 0) body += ` and ${hidden} more.`;
  // Last resort: keep the trailing note and cut the body on a code point boundary.
  return capText(body, DECISION_MAX - note.length) + note;
}

export function describePreviewResult(
  m: {
    verdict: PolicyVerdict;
    action: PolicyAction;
    effectiveAction: PolicyAction;
    downgrade: Downgrade | null;
  },
  o: { truncated: boolean },
): string {
  const note = o.truncated ? ` ${TRUNCATED}` : '';
  if (m.verdict === 'no_match')
    return capText('No match: no action would be taken.', PREVIEW_MAX - note.length) + note;
  const head = m.verdict === 'clear_match' ? 'Clear match' : 'Possible match';
  let body: string;
  if (!m.downgrade) body = `would ${VERB[m.effectiveAction]}`;
  else {
    const why = m.downgrade === 'low_confidence' ? '' : ` (${DOWNGRADE[m.downgrade]})`;
    body = `would ${VERB.flag} instead of ${VERB[m.action]}${why}`;
  }
  return capText(`${head}: ${body}.`, PREVIEW_MAX - note.length) + note;
}

/** `code` must already be a closed snake_case outcome code (see `safeOutcomeCode`). */
export function describeFallback(kind: 'hide' | 'delete', code: string): string {
  return `A policy asked to ${kind} this comment, but the platform did not allow it (${code}). Flagged for review instead.`;
}
