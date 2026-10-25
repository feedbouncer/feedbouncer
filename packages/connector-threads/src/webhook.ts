// Threads reply webhooks. The payload is unsigned-until-verified input; once verified, only the
// ids and the time are read. Text and username are never touched, so nothing a stranger wrote
// can travel through this path.
import type { InboundEvent, WebhookSpec } from '@feedbouncer/connectors';
import * as z from 'zod';
import type { ThreadsConfig } from './config.js';
import { MEDIA_ID, threadsTime } from './ids.js';

const MAX_VALUES = 100;
const ID = z.string().regex(MEDIA_ID);

const ITEM = z.object({ field: z.string(), value: z.unknown() });
const PAYLOAD = z.object({
  app_id: z.string(),
  values: z.union([ITEM, z.array(ITEM).max(MAX_VALUES)]),
});
const REPLY = z.object({
  id: ID,
  timestamp: z.string(),
  root_post: z.object({ id: ID, owner_id: ID }),
});

export function parseThreadsWebhook(raw: Buffer, appId: string): readonly InboundEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }
  const payload = PAYLOAD.safeParse(json);
  if (!payload.success || payload.data.app_id !== appId) return [];
  const items = Array.isArray(payload.data.values) ? payload.data.values : [payload.data.values];
  const out: InboundEvent[] = [];
  for (const item of items) {
    if (item.field !== 'replies') continue;
    const v = REPLY.safeParse(item.value);
    if (!v.success) continue;
    let occurredAt: Date;
    try {
      occurredAt = threadsTime(v.data.timestamp);
    } catch {
      continue;
    }
    out.push({
      type: 'comment.created',
      externalAccountId: v.data.root_post.owner_id,
      ref: { sourceExternalId: v.data.root_post.id, externalId: v.data.id },
      occurredAt,
    });
  }
  return out;
}

export const threadsWebhookSpec = (cfg: ThreadsConfig): WebhookSpec => ({
  secretSource: 'app',
  signature: {
    header: 'x-hub-signature-256',
    prefix: 'sha256=',
    encoding: 'hex',
    timestampHeader: null,
    signedPayload: (raw) => raw,
  },
  // Meta signs no timestamp; replay protection is the permanent dedupe record.
  parse: (raw) => parseThreadsWebhook(raw, cfg.appId),
});
