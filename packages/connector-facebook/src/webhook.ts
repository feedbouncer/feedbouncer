// Meta feed webhooks. Every id in a payload is untrusted: events whose ids do
// not match GRAPH_ID are dropped so nothing hostile can reach a URL later.
import { timingSafeEqual } from 'node:crypto';
import type { InboundEvent, WebhookSpec } from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';
import { GRAPH_ID } from './graph.js';

const MAX_EVENTS = 1000;
const TYPE: Readonly<Record<string, InboundEvent['type']>> = {
  add: 'comment.created',
  edited: 'comment.updated',
  hide: 'comment.updated',
  unhide: 'comment.updated',
  remove: 'comment.deleted',
};
const isId = (v: unknown): v is string => typeof v === 'string' && GRAPH_ID.test(v);

function toDate(v: unknown): Date | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v > 1e12 ? v : v * 1000);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function parseFeedWebhook(rawBody: Buffer): readonly InboundEvent[] {
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return [];
  }
  const d = doc as { object?: unknown; entry?: unknown } | null;
  if (d?.object !== 'page' || !Array.isArray(d.entry)) return [];
  const out: InboundEvent[] = [];
  for (const entry of d.entry as unknown[]) {
    const e = entry as { id?: unknown; time?: unknown; changes?: unknown } | null;
    if (!e || !isId(e.id) || !Array.isArray(e.changes)) continue;
    for (const change of e.changes as unknown[]) {
      if (out.length >= MAX_EVENTS) return out;
      const c = change as { field?: unknown; value?: Record<string, unknown> | null } | null;
      const v = c?.value;
      if (c?.field !== 'feed' || !v || v.item !== 'comment' || typeof v.verb !== 'string') continue;
      const type = Object.hasOwn(TYPE, v.verb) ? TYPE[v.verb] : undefined;
      if (!type || !isId(v.comment_id) || !isId(v.post_id)) continue;
      const occurredAt = toDate(type === 'comment.created' ? v.created_time : e.time);
      if (!occurredAt) continue;
      out.push({
        type,
        externalAccountId: e.id,
        ref: { sourceExternalId: v.post_id, externalId: v.comment_id },
        occurredAt,
      });
    }
  }
  return out;
}

export const facebookWebhookSpec: WebhookSpec = {
  secretSource: 'app',
  signature: {
    header: 'x-hub-signature-256',
    prefix: 'sha256=',
    encoding: 'hex',
    timestampHeader: null,
    signedPayload: (raw) => raw,
  },
  // Meta signs no timestamp; replay protection is the permanent dedupe record.
  toleranceSec: 300,
  parse: parseFeedWebhook,
};

const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

export function verifyHandshake(
  q: Readonly<Record<string, unknown>>,
  verifyToken: Secret,
): { ok: true; challenge: string } | { ok: false } {
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  if (
    mode !== 'subscribe' ||
    typeof token !== 'string' ||
    typeof challenge !== 'string' ||
    !CHALLENGE.test(challenge)
  ) {
    return { ok: false };
  }
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(verifyToken.reveal(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge };
}
