import { createHash } from 'node:crypto';
import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { JobEnqueueError } from './errors.js';

export const EXTERNAL_REF = /^[A-Za-z0-9._:@/-]{1,256}$/;
export const CALLER_KEY = /^[\x21-\x7e]{1,256}$/;
/** Codes and job type names: lower snake case, at most 63 chars. */
export const SNAKE_CASE = /^[a-z][a-z0-9_]{0,62}$/;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type KeyInput = { scope: ConnectionScope; platform: Platform; type: string } & (
  | { externalRef: string; callerKey?: never }
  | { callerKey: string; externalRef?: never }
);

/** sha256 over a JSON array (no delimiter ambiguity) of the full tenant scope + identity. */
export function deriveIdempotencyKey(i: KeyInput): string {
  const [kind, value, re] =
    i.externalRef !== undefined
      ? (['ref', i.externalRef, EXTERNAL_REF] as const)
      : (['caller', i.callerKey, CALLER_KEY] as const);
  if (typeof value !== 'string' || !re.test(value)) {
    throw new JobEnqueueError('invalid_idempotency_key');
  }
  const { organizationId, brandId, connectionId } = i.scope;
  return createHash('sha256')
    .update(
      JSON.stringify([
        'fb-job-key-v1',
        organizationId,
        brandId,
        connectionId,
        i.platform,
        i.type,
        kind,
        value,
      ]),
    )
    .digest('hex');
}

export const bullJobId = (key: string): string => `j_${key}`;
