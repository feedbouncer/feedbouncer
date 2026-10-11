// Every error response has one shape: { error: { code, message } }. Codes are
// stable API contract; messages are plain sentences safe to show a user and
// never contain request values, SQL, stack traces or secrets.
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_origin'
  | 'not_found'
  | 'internal_error'
  | 'invalid_email'
  | 'password_too_short'
  | 'password_too_long'
  | 'weak_password'
  | 'invalid_credentials'
  | 'invalid_or_expired_token'
  | 'unauthenticated'
  | 'forbidden'
  | 'email_not_verified'
  | 'sole_owner'
  | 'rate_limited'
  | 'temporarily_unavailable';

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'The request is not valid.',
  invalid_origin: 'Request origin is not allowed.',
  not_found: 'Not found.',
  internal_error: 'Something went wrong.',
  invalid_email: 'Enter a valid email address.',
  password_too_short: 'Use at least 12 characters.',
  password_too_long: 'Use at most 128 characters.',
  weak_password: 'This password is too easy to guess. Try a longer phrase.',
  invalid_credentials: 'Email or password is incorrect.',
  invalid_or_expired_token: 'This link is invalid or has expired. Request a new one.',
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You do not have permission to do this.',
  email_not_verified: 'Verify your email address first.',
  sole_owner: 'You are the only owner of an organization. Transfer ownership or delete it first.',
  rate_limited: 'Too many attempts. Try again later.',
  temporarily_unavailable: 'Temporarily unavailable. Try again shortly.',
};

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
  }
}

export const notFound = (): ApiError => new ApiError(404, 'not_found');

export function errorBody(e: ApiError): { error: { code: ErrorCode; message: string } } {
  return { error: { code: e.code, message: e.message } };
}

// Maps anything thrown in Nest (or by Fastify before a handler, which Nest
// wraps in an HttpException) to the envelope. HttpException texts are not
// forwarded: they can quote request input (e.g. JSON parse errors).
function toApiError(err: unknown): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (!(err instanceof HttpException)) return undefined;
  const status = err.getStatus();
  if (status === 404) return notFound();
  if (status === 413) return new ApiError(413, 'invalid_request', 'Request body too large.');
  if (status === 415) return new ApiError(415, 'invalid_request', 'Unsupported content type.');
  if (status >= 400 && status < 500) return new ApiError(400, 'invalid_request');
  return undefined;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let e = toApiError(err);
    if (!e) {
      this.log.error('unhandled error', errorFields(err));
      e = new ApiError(500, 'internal_error');
    }
    void reply.status(e.status).header('cache-control', 'no-store').send(errorBody(e));
  }
}
