import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import { hashInvitationToken } from '../invitations/token.js';
import { parseBody, zName } from '../http/validation.js';
import { AUTH, AUTH_EMAILS, DEPS, RATE_LIMITS } from '../tokens.js';
import { runApprovedSignUp, type Auth } from './auth.js';
import { normalizeEmail } from './email.js';
import type { AuthEmails } from './emails.js';
import { assertPassword, PASSWORD_MAX } from './password-policy.js';
import type { AuthRateLimits } from './rate-limit.js';
import { hasPendingInvitationFor, isSignupAllowed } from './signup-gate.js';
import { findUserIdByEmail } from './users.repo.js';

// Generous raw caps: the policy (in code points) decides, these only bound input.
const SignUp = z.strictObject({
  email: z.string().max(400),
  password: z.string().max(PASSWORD_MAX * 4),
  name: zName,
  invitationToken: z.string().max(100).optional(),
});
const ACCEPTED = { status: 'verification_sent' } as const;

@Controller('api/v1/auth')
export class SignUpController {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(AUTH_EMAILS) private readonly emails: AuthEmails,
    @Inject(RATE_LIMITS) private readonly limits: AuthRateLimits,
  ) {}

  @Get('sign-up')
  availability(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return { enabled: this.deps.env.signupEnabled };
  }

  // The same 202 for a new, an existing and a not-allowed address: the latter two get
  // an email instead, so the response reveals nothing.
  @Post('sign-up')
  @HttpCode(202)
  async signUp(@Body() body: unknown, @Req() req: FastifyRequest) {
    const input = parseBody(SignUp, body);
    const email = normalizeEmail(input.email);
    if (!this.deps.env.signupEnabled) await this.assertInvited(input.invitationToken, email);
    assertPassword(input.password, [email, input.name]);
    await this.limits.consumeEmailSend(email, req.ip);
    if (await findUserIdByEmail(this.deps.pool, email)) {
      await hashPassword(input.password); // equalize timing with the create path
      this.emails.accountExists(email);
      return ACCEPTED;
    }
    if (!(await isSignupAllowed(this.deps.pool, this.deps.env.signupAllowlist, email))) {
      await hashPassword(input.password); // equalize timing with the create path
      this.emails.signupClosed(email);
      return ACCEPTED;
    }
    try {
      await runApprovedSignUp(() =>
        this.auth.api.signUpEmail({
          body: { email, password: input.password, name: input.name, callbackURL: '/verified' },
        }),
      );
    } catch (err) {
      // Lost a race with a concurrent sign-up for the same address.
      if (await findUserIdByEmail(this.deps.pool, email)) this.emails.accountExists(email);
      else throw err;
    }
    return ACCEPTED;
  }

  // While sign-up is off only a valid invitation token for this same address gets through.
  // This runs before anything that depends on the address, so every refusal looks alike.
  private async assertInvited(token: string | undefined, email: string): Promise<void> {
    const hash = hashInvitationToken(token);
    if (hash && (await hasPendingInvitationFor(this.deps.pool, hash, email))) return;
    this.deps.log.info('auth.signup_rejected_disabled', {
      invitationPresented: token !== undefined,
    });
    throw new ApiError(403, 'signup_disabled');
  }
}
