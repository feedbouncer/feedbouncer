export const SIGNUP_ENABLED_WARNING =
  'SIGNUP_ENABLED has an unrecognized value; sign-up stays enabled (accepted: true/false, 1/0, yes/no, on/off).';

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'off']);

/** Sign-up is on unless the value is a recognized false spelling; a typo keeps it on and warns. */
export function parseSignupEnabled(raw: string | undefined, warn: (msg: string) => void): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (FALSE_VALUES.has(value)) return false;
  if (value !== '' && !TRUE_VALUES.has(value)) warn(SIGNUP_ENABLED_WARNING);
  return true;
}
