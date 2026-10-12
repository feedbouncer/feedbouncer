import { Secret, isSecretField } from '@feedbouncer/service-runtime';
import { JobError, type JobResult } from './failure.js';
import { JobEnqueueError } from './errors.js';

export const MAX_PAYLOAD_BYTES = 65_536;
export const MAX_RESULT_BYTES = 8_192;
const MAX_DEPTH = 16;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function walk(v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new JobEnqueueError('invalid_payload');
  if (v instanceof Secret) throw new JobEnqueueError('payload_contains_secret');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new JobEnqueueError('invalid_payload');
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walk(x, depth + 1);
    return;
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new JobEnqueueError('invalid_payload');
      if (isSecretField(k)) throw new JobEnqueueError('payload_contains_secret');
      walk((v as Record<string, unknown>)[k], depth + 1);
    }
    return;
  }
  throw new JobEnqueueError('invalid_payload');
}

/** Validates a parsed payload is plain JSON, secret-free and bounded; returns its JSON text. */
export function assertSafePayload(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobEnqueueError('invalid_payload');
  }
  walk(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new JobEnqueueError('payload_too_large');
  }
  return json;
}

const RESULT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function validateJobResult(r: unknown): JobResult {
  const bad = () => new JobError('non_retryable', 'invalid_job_result');
  if (
    r === null ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    Object.getPrototypeOf(r) !== Object.prototype
  ) {
    throw bad();
  }
  const entries = Object.entries(r);
  if (entries.length > 32) throw bad();
  for (const [k, v] of entries) {
    if (!RESULT_KEY.test(k) || isSecretField(k)) throw bad();
    const ok =
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= 1_024);
    if (!ok) throw bad();
  }
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > MAX_RESULT_BYTES) throw bad();
  return r as JobResult;
}
