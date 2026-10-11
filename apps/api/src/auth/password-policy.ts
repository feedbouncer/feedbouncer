import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';
import { ApiError } from '../http/errors.js';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export type PasswordProblem = 'password_too_short' | 'password_too_long' | 'weak_password';

const zxcvbn = new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...en.dictionary },
  graphs: common.adjacencyGraphs,
  translations: en.translations,
});

export function checkPassword(pw: string, userInputs: string[]): PasswordProblem | null {
  const len = [...pw].length;
  if (len < PASSWORD_MIN) return 'password_too_short';
  if (len > PASSWORD_MAX) return 'password_too_long';
  const inputs = [
    ...userInputs,
    ...userInputs.flatMap((s) => s.split(/[@.\s]+/)),
    'feedbouncer',
  ].filter((s) => s.length >= 3);
  return zxcvbn.check(pw, inputs).score >= 3 ? null : 'weak_password';
}

/** Throws 422 with the problem as code; the message never contains the password. */
export function assertPassword(pw: string, userInputs: string[]): void {
  const p = checkPassword(pw, userInputs);
  if (p) throw new ApiError(422, p);
}
