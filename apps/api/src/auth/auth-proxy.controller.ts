import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import { AUTH, DEPS, RATE_LIMITS } from '../tokens.js';
import { CLIENT_IP_HEADER, runAccountDeletion, type Auth } from './auth.js';
import { normalizeEmail } from './email.js';
import { assertPassword } from './password-policy.js';
import type { AuthRateLimits } from './rate-limit.js';

// Only these Better Auth endpoints are reachable, and each gets a rebuilt body
// with only the fields we accept: nothing the client adds (callback URLs,
// redirect targets, flags) reaches Better Auth. Responses are rewritten to our
// error envelope so they never reveal whether an account exists or carry tokens.
type Kind =
  | 'sign-in'
  | 'sign-out'
  | 'verify-email'
  | 'email-send'
  | 'reset-password'
  | 'change-password'
  | 'delete-user';
export const ROUTES: Readonly<Record<string, Kind>> = {
  'POST /sign-in/email': 'sign-in',
  'POST /sign-out': 'sign-out',
  'GET /verify-email': 'verify-email',
  'POST /send-verification-email': 'email-send',
  'POST /request-password-reset': 'email-send',
  'POST /reset-password': 'reset-password',
  'POST /change-password': 'change-password',
  'POST /delete-user': 'delete-user',
};
const OK = { status: 'ok' } as const;
const FORWARD_HEADERS = ['cookie', 'user-agent'];
const MAX_LOGIN_PASSWORD = 512;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
// A password Better Auth is asked to verify. It skips verification for falsy
// values (an empty string), so anything that is not a non-empty string within
// the bound is refused here, as a wrong credential, without being forwarded.
const credential = (v: unknown): string => {
  const s = str(v);
  if (s === undefined || s.length === 0 || s.length > MAX_LOGIN_PASSWORD) {
    throw new ApiError(401, 'invalid_credentials');
  }
  return s;
};

@Controller('api/auth')
export class AuthProxyController {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(RATE_LIMITS) private readonly limits: AuthRateLimits,
  ) {}

  @All('*')
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const web = this.deps.env.publicWebUrl.origin;
    const url = new URL(req.url, web);
    const sub = url.pathname.slice('/api/auth'.length);
    const kind = ROUTES[`${req.method} ${sub}`];
    if (!kind) throw notFound();

    const input: Record<string, unknown> =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    // Email whose counters this request touches (login failures, reset), if any.
    let email: string | null = null;
    let forward: Record<string, unknown> | undefined;
    let search = '';

    switch (kind) {
      case 'sign-in': {
        email = normalizeEmail(input.email);
        const password = credential(input.password);
        await this.limits.reserveLoginAttempt(email, req.ip);
        forward = { email, password };
        break;
      }
      case 'email-send':
        email = normalizeEmail(input.email);
        await this.limits.consumeEmailSend(email, req.ip);
        forward =
          sub === '/request-password-reset'
            ? { email, redirectTo: `${web}/reset-password` }
            : { email, callbackURL: '/verified' };
        break;
      case 'reset-password': {
        const token = str(input.token);
        const newPassword = str(input.newPassword);
        if (token === undefined || newPassword === undefined) {
          throw new ApiError(400, 'invalid_request');
        }
        assertPassword(newPassword, []);
        forward = { token, newPassword };
        break;
      }
      case 'change-password':
      case 'delete-user': {
        const session = await this.auth.api.getSession({ headers: toHeaders(req) });
        if (!session) throw new ApiError(401, 'unauthenticated');
        email = session.user.email;
        const current = credential(kind === 'delete-user' ? input.password : input.currentPassword);
        // Both verify the current password, so they count as guessing attempts.
        await this.limits.reserveLoginAttempt(email, req.ip);
        if (kind === 'delete-user') {
          forward = { password: current };
        } else {
          const currentPassword = current;
          const newPassword = str(input.newPassword);
          if (newPassword === undefined) throw new ApiError(400, 'invalid_request');
          assertPassword(newPassword, [email, session.user.name]);
          forward = { currentPassword, newPassword, revokeOtherSessions: true };
        }
        break;
      }
      case 'verify-email': {
        const token = str(url.searchParams.get('token'));
        if (!token) return redirect(reply, '/verified?error=invalid_token');
        search = `?${new URLSearchParams({ token, callbackURL: '/verified' })}`; // never a client-chosen target
        break;
      }
      case 'sign-out':
        forward = {};
        break;
    }

    const headers = toHeaders(req);
    headers.set(CLIENT_IP_HEADER, req.ip); // always overwritten: a client-supplied value is never trusted
    if (forward) {
      headers.set('content-type', 'application/json');
      headers.set('origin', web); // the origin guard already vetted this request
    }
    const call = () =>
      this.auth.handler(
        new Request(`${web}/api/auth${sub}${search}`, {
          method: req.method,
          headers,
          ...(forward ? { body: JSON.stringify(forward) } : {}),
        }),
      );
    const upstream = await (kind === 'delete-user' ? runAccountDeletion(call) : call());
    for (const c of upstream.headers.getSetCookie()) void reply.header('set-cookie', c);
    const s = upstream.status;

    switch (kind) {
      case 'sign-in':
        if (s === 200) {
          await this.limits.recordLoginSuccess(email!, req.ip);
          return send(reply, 200, OK);
        }
        if (s >= 500) throw new ApiError(500, 'internal_error');
        throw new ApiError(401, 'invalid_credentials'); // the attempt was counted before the check
      case 'sign-out':
      case 'email-send':
        // Never reveal whether a session or address exists; an upstream
        // failure says nothing about either.
        if (s >= 500) throw new ApiError(500, 'internal_error');
        return send(reply, 200, OK);
      case 'reset-password':
        if (s === 200) return send(reply, 200, OK);
        if (s >= 500) throw new ApiError(500, 'internal_error');
        throw new ApiError(400, 'invalid_or_expired_token');
      case 'change-password':
      case 'delete-user':
        if (s === 200) {
          await this.limits.recordLoginSuccess(email!, req.ip);
          return send(reply, 200, OK);
        }
        if (kind === 'delete-user' && (s === 409 || s === 503)) {
          // The password was verified before the deletion was refused or
          // rolled back (a lock conflict: nothing was deleted, retrying works).
          await this.limits.recordLoginSuccess(email!, req.ip);
          throw s === 409
            ? new ApiError(409, 'sole_owner')
            : new ApiError(503, 'temporarily_unavailable');
        }
        if (s === 400 || s === 401) throw new ApiError(401, 'invalid_credentials');
        throw new ApiError(500, 'internal_error');
      case 'verify-email': {
        const ok =
          s >= 300 && s < 400 && !(upstream.headers.get('location') ?? '').includes('error=');
        return redirect(reply, ok ? '/verified' : '/verified?error=invalid_token');
      }
    }
  }
}

function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = req.headers[name];
    if (typeof v === 'string') h.set(name, v);
  }
  return h;
}

function redirect(reply: FastifyReply, location: string): void {
  void reply.status(302).header('location', location).send();
}

function send(reply: FastifyReply, status: number, body: unknown): void {
  void reply.status(status).header('cache-control', 'no-store').send(body);
}
