// Nest DI tokens. Vitest does not emit decorator metadata, so every injected
// constructor parameter names its token with @Inject(TOKEN).
export const DEPS = Symbol('DEPS');
