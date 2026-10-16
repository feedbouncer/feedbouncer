import { z } from 'zod';
import { ApiError, notFound } from './errors.js';

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** Organization and brand names: 1..200 characters after trim, no control characters. */
export const zName = z.string().trim().min(1).max(200).regex(NO_CONTROL);
export const zUuid = z.uuid();

const IANA_SHAPE = /^(?:UTC|[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)+)$/;

/** An IANA zone name the runtime knows. Postgres has the last word (see BrandsService). */
export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64 || !IANA_SHAPE.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export const zTimeZone = z.string().refine(isIanaTimeZone);

/** Path IDs: anything that is not a UUID cannot exist, so it is a plain 404. */
export function parseUuidOr404(v: unknown): string {
  const r = zUuid.safeParse(v);
  if (!r.success) throw notFound();
  return r.data;
}

/** Validates a request body. Build schemas with z.strictObject so unknown keys fail. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    // Field names only: values are never echoed back.
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.')))]
      .filter(Boolean)
      .join(', ');
    throw new ApiError(400, 'invalid_request', `Invalid or missing fields: ${fields || 'body'}.`);
  }
  return r.data;
}
