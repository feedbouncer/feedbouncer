// Instagram comments webhooks (object "instagram"). Every id is untrusted and
// must pass GRAPH_ID or the change is dropped. Comment text is deliberately not
// read: it is fetched from Graph on ingest.
import { facebookWebhookSpec, GRAPH_ID } from '@feedbouncer/connector-facebook';
import type { InboundEvent, WebhookSpec } from '@feedbouncer/connectors';

export const MAX_EVENTS_PER_DELIVERY = 1000;

const id = (v: unknown): string | null => (typeof v === 'string' && GRAPH_ID.test(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function toDate(v: unknown): Date {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return new Date();
  const d = new Date(v > 1e12 ? v : v * 1000);
  return Number.isFinite(d.getTime()) ? d : new Date();
}

export function parseInstagramWebhook(rawBody: Buffer): readonly InboundEvent[] {
  let root: unknown;
  try {
    root = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return [];
  }
  if (!isObj(root) || root.object !== 'instagram' || !Array.isArray(root.entry)) return [];
  const out: InboundEvent[] = [];
  for (const entry of root.entry as unknown[]) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    const account = id(entry.id);
    if (!account) continue;
    const occurredAt = toDate(entry.time);
    for (const ch of entry.changes as unknown[]) {
      if (out.length >= MAX_EVENTS_PER_DELIVERY) return out;
      if (!isObj(ch) || ch.field !== 'comments' || !isObj(ch.value)) continue;
      const v = ch.value;
      const media = isObj(v.media) ? v.media : null;
      if (
        media &&
        typeof media.media_product_type === 'string' &&
        media.media_product_type.toUpperCase() === 'LIVE'
      ) {
        continue;
      }
      const commentId = id(v.comment_id);
      const mediaId = media ? id(media.id) : null;
      if (!commentId || !mediaId) continue;
      out.push({
        type: 'comment.created',
        externalAccountId: account,
        ref: { sourceExternalId: mediaId, externalId: commentId },
        occurredAt,
      });
    }
  }
  return out;
}

export const instagramWebhookSpec: WebhookSpec = {
  secretSource: 'app',
  // Same app, same header, same HMAC as the Facebook feed webhook.
  signature: facebookWebhookSpec.signature,
  parse: parseInstagramWebhook,
};
