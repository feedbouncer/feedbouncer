// Values published in .env.example and CI. They are public, so production must
// refuse them; development and test accept them with a warning.
// placeholders.test.ts keeps this list in sync with .env.example.
import { EnvError, type AppEnv } from './env.js';

/** The documented development encryption key from .env.example (public by design). */
export const DEV_EXAMPLE_ENCRYPTION_KEY = 'RiOYH93nnaej+o4hWDiBb6XqRseP2Fv5uDL8wejvLwY=';

export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'dev-only-postgres-password',
  'dev-only-redis-password',
  'dev-only-auth-secret-change-me-0123456789',
  'dev-only-ci-postgres',
  DEV_EXAMPLE_ENCRYPTION_KEY,
]);

export function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER_VALUES.has(value)) return true;
  try {
    const url = new URL(value);
    return url.password !== '' && PLACEHOLDER_VALUES.has(decodeURIComponent(url.password));
  } catch {
    return false;
  }
}

export function checkNotPlaceholder(
  appEnv: AppEnv,
  name: string,
  value: string,
  warn: (msg: string) => void,
): void {
  if (!isPlaceholder(value)) return;
  if (appEnv === 'production') {
    throw new EnvError(
      `${name} is set to a documented example value from .env.example. Production needs a freshly generated secret (value not shown).`,
    );
  }
  warn(
    `${name} uses a documented example value. That is fine for local ${appEnv} only; never deploy it.`,
  );
}
