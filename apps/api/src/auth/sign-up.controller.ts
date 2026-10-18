import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { parseBody, zName } from '../http/validation.js';
import { AUTH, AUTH_EMAILS, DEPS, RATE_LIMITS } from '../tokens.js';
import type { Auth } from './auth.js';
import { normalizeEmail } from './email.js';
import type { AuthEmails } from './emails.js';
import { assertPassword, PASSWORD_MAX } from './password-policy.js';
import type { AuthRateLimits } from './rate-limit.js';
import { isSignupAllowed } from './signup-gate.js';
import { findUserIdByEmail } from './users.repo.js';

// Generous raw caps: the policy (in code points) decides, these only bound input.
const SignUp = z.strictObject({
  email: z.string().max(400),
  password: z.string().max(PASSWORD_MAX * 4),
  name: zName,
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

  // The same 202 for a new, an existing and a not-allowed address: the latter two get
  // an email instead, so the response reveals nothing.
  @Post('sign-up')
  @HttpCode(202)
  async signUp(@Body() body: unknown, @Req() req: FastifyRequest) {
    const input = parseBody(SignUp, body);
    const email = normalizeEmail(input.email);
    assertPassword(input.password, [email, input.name]);
    await this.limits.consumeEmailSend(email, req.ip);
    if (!(await isSignupAllowed(this.deps.pool, this.deps.env.signupAllowlist, email))) {
      await hashPassword(input.password); // equalize timing with the create path
      this.emails.signupClosed(email);
      return ACCEPTED;
    }
    if (await findUserIdByEmail(this.deps.pool, email)) {
      await hashPassword(input.password); // equalize timing with the create path
      this.emails.accountExists(email);
      return ACCEPTED;
    }
    try {
      await this.auth.api.signUpEmail({
        body: { email, password: input.password, name: input.name, callbackURL: '/verified' },
      });
    } catch (err) {
      // Lost a race with a concurrent sign-up for the same address.
      if (await findUserIdByEmail(this.deps.pool, email)) this.emails.accountExists(email);
      else throw err;
    }
    return ACCEPTED;
  }
}
