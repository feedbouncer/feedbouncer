import { createHmac, randomBytes } from 'node:crypto';
import { Secret } from '@feedbouncer/service-runtime';

const PREFIX = 'whsec_';

export function generateSigningSecret(): Secret {
  return new Secret(PREFIX + randomBytes(32).toString('base64'));
}

export function signatureHeader(
  secrets: readonly Secret[],
  msgId: string,
  timestampSec: number,
  body: string,
): string {
  const content = `${msgId}.${timestampSec}.${body}`;
  return secrets
    .map((s) => {
      const key = Buffer.from(s.reveal().slice(PREFIX.length), 'base64');
      return `v1,${createHmac('sha256', key).update(content).digest('base64')}`;
    })
    .join(' ');
}

export function deliveryHeaders(i: {
  eventId: string;
  eventType: string;
  deliveryId: string;
  timestampSec: number;
  signature: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'FeedBouncer-Webhooks/1',
    'webhook-id': i.eventId,
    'webhook-timestamp': String(i.timestampSec),
    'webhook-signature': i.signature,
    'feedbouncer-event-type': i.eventType,
    'feedbouncer-delivery-id': i.deliveryId,
  };
}
