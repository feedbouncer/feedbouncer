import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getAdapter } from 'better-auth/db/adapter';
import { errorFields } from '@feedbouncer/service-runtime';
import type { AppDeps } from '../deps.js';
import type { AuthEmails } from './emails.js';
import { withSessionTokenDigests } from './session-token-digest.js';

/** Thrown by AuthHooks.beforeDeleteUser to deny a deletion on purpose. */
export class UserDeletionBlockedError extends Error {
  constructor(message = 'user deletion blocked') {
    super(message);
    this.name = 'UserDeletionBlockedError';
  }
}

export interface AuthHooks {
  /**
   * Throws UserDeletionBlockedError when the user must not be deleted (for
   * example, sole owner of an organization); that is reported as 409
   * `sole_owner`. Any other error is an unexpected failure: it is not mapped,
   * so it surfaces as a server error and is logged.
   */
  beforeDeleteUser(userId: string): Promise<void>;
}

const ts = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;

// Better Auth is mapped onto the hand-written auth_* tables (packages/db); its
// own migrations and CLI are never used. Bearer secrets are stored as SHA-256
// digests: session tokens through withSessionTokenDigests, verification
// identifiers (reset-password:<token>, ...) through storeIdentifier: 'hashed'.
export function createAuth(deps: AppDeps, emails: AuthEmails, hooks: AuthHooks) {
  const web = deps.env.publicWebUrl.origin;
  return betterAuth({
    appName: 'FeedBouncer',
    baseURL: web,
    basePath: '/api/auth',
    secret: deps.env.authSecret,
    database: (options: BetterAuthOptions) => {
      const adapter = getAdapter({ ...options, database: deps.pool });
      adapter.catch(() => {}); // surfaced by the first query that awaits it
      return withSessionTokenDigests(adapter);
    },
    trustedOrigins: [web],
    rateLimit: { enabled: false }, // the API's Redis limiter owns rate limiting
    telemetry: { enabled: false },
    // Into our redacting JSON logger. Extra arguments (request data, rows) are
    // dropped; an Error is reduced to its name, code and redacted message.
    logger: {
      level: 'warn',
      log: (level, message, ...args: unknown[]) => {
        const err = args.find((a) => a instanceof Error);
        deps.log[level](`better-auth: ${message}`, err ? errorFields(err) : {});
      },
    },
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: 'fb',
      useSecureCookies: deps.env.publicWebUrl.protocol === 'https:',
    },
    user: {
      modelName: 'app_user',
      fields: { name: 'display_name', emailVerified: 'email_verified', ...ts },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          try {
            await hooks.beforeDeleteUser(user.id);
          } catch (err) {
            if (err instanceof UserDeletionBlockedError) {
              throw new APIError('CONFLICT', { message: 'sole_owner' });
            }
            throw err;
          }
        },
      },
    },
    session: {
      modelName: 'auth_session',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        ...ts,
      },
      expiresIn: 604_800,
      updateAge: 86_400,
      cookieCache: { enabled: false }, // removal, role changes and logout apply on the next request
    },
    account: {
      modelName: 'auth_account',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        password: 'password_hash',
        ...ts,
      },
    },
    verification: {
      modelName: 'auth_verification',
      fields: { expiresAt: 'expires_at', ...ts },
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      requireEmailVerification: false, // login allowed; creating or joining an org is gated by the API
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3_600,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => emails.passwordReset(user.email, url),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 86_400,
      sendVerificationEmail: async ({ user, url }) => emails.verify(user.email, url),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
