// Nest DI tokens. Vitest does not emit decorator metadata, so every injected
// constructor parameter names its token with @Inject(TOKEN).
export const DEPS = Symbol('DEPS');
export const AUTH = Symbol('AUTH');
export const AUTH_EMAILS = Symbol('AUTH_EMAILS');
export const RATE_LIMITS = Symbol('RATE_LIMITS');
/** The AuthHooks Better Auth calls before deleting a user. */
export const ACCOUNT_DELETION = Symbol('ACCOUNT_DELETION');
