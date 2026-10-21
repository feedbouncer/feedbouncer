// Nest DI tokens. Vitest does not emit decorator metadata, so every injected
// constructor parameter names its token with @Inject(TOKEN).
export const DEPS = Symbol('DEPS');
export const AUTH = Symbol('AUTH');
export const AUTH_EMAILS = Symbol('AUTH_EMAILS');
export const RATE_LIMITS = Symbol('RATE_LIMITS');
/** The AuthHooks Better Auth calls before deleting a user. */
export const ACCOUNT_DELETION = Symbol('ACCOUNT_DELETION');
/** The connector stack (AppDeps.connectors), or null when not configured. */
export const CONNECTOR_STACK = Symbol('CONNECTOR_STACK');
/** The enqueue-only job producer, or null when not configured. */
export const JOB_PRODUCER = Symbol('JOB_PRODUCER');
/** Comment store and moderation actions, or null when not configured. */
export const COMMENTS = Symbol('COMMENTS');
/** Per-connection backfill run state. */
export const BACKFILL_STORE = Symbol('BACKFILL_STORE');
/** The API key store. */
export const API_KEYS = Symbol('API_KEYS');
/** Per-key and per-address rate limits of the public API. */
export const PUBLIC_API_LIMITS = Symbol('PUBLIC_API_LIMITS');
/** The moderation-check queue client: enqueues text checks and waits for the worker. */
export const MODERATION_CHECK_CLIENT = Symbol('MODERATION_CHECK_CLIENT');
/** Subject export and erasure requests (identifiers sealed in Postgres). */
export const PRIVACY_REQUESTS = Symbol('PRIVACY_REQUESTS');
/** Enqueues privacy requests for the worker. */
export const PRIVACY_QUEUE_CLIENT = Symbol('PRIVACY_QUEUE_CLIENT');
