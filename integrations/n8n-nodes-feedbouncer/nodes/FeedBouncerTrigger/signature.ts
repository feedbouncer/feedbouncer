import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_TOLERANCE_SECONDS } from '../shared/constants';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' | 'no_secret' };

const SECRET_PREFIX = 'whsec_';
const SIGNATURE_LENGTH = 32;
const MIN_KEY_BYTES = 24;

const decodeKey = (secret: string): Buffer | null => {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  return key.length >= MIN_KEY_BYTES ? key : null;
};

export const isValidSecret = (secret: unknown): secret is string => typeof secret === 'string' && decodeKey(secret) !== null;

/** Standard Webhooks (v1, HMAC-SHA256) over `${id}.${timestamp}.${rawBody}`. */
export function verifySignature(input: {
  secret: string | undefined;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
  nowSec: number;
}): VerifyResult {
  const { secret, id, timestamp, signatureHeader, rawBody, nowSec } = input;
  const key = secret ? decodeKey(secret) : null;
  if (!key) return { ok: false, reason: 'no_secret' };
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();

  for (const entry of signatureHeader.split(' ')) {
    const [version, encoded] = entry.split(',');
    if (version !== 'v1' || !encoded) continue;
    const candidate = Buffer.from(encoded, 'base64');
    if (candidate.length === SIGNATURE_LENGTH && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}
