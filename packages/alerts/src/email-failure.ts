import { CODE_RE } from './constants.js';

export type EmailFailure = { ok: false; kind: 'invalid' | 'transient'; code: string };

export function classifyEmailFailure(err: unknown): EmailFailure {
  const cause = (err instanceof Error ? err.cause : undefined) as
    | { responseCode?: unknown; code?: unknown }
    | undefined;
  const rc = typeof cause?.responseCode === 'number' ? cause.responseCode : null;
  if (rc !== null && rc >= 500 && rc <= 599)
    return { ok: false, kind: 'invalid', code: `smtp_${rc}` };
  if (rc !== null && rc >= 400 && rc <= 499)
    return { ok: false, kind: 'transient', code: `smtp_${rc}` };
  const raw = typeof cause?.code === 'string' ? cause.code : '';
  const code = raw.toLowerCase();
  return {
    ok: false,
    kind: 'transient',
    code: CODE_RE.test(code) ? code : 'smtp_error',
  };
}
