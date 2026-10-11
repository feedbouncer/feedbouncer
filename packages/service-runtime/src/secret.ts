// Holds a decrypted credential or other secret. The value lives in a #private
// field (invisible to util.inspect, console.dir and Object.keys); every
// coercion path returns "[redacted]". Call reveal() only at the point of use
// (the outbound platform call), never to log or return it.
import { timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

export const REDACTED = '[redacted]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Secret value must be a non-empty string');
    }
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  equals(other: Secret): boolean {
    const a = Buffer.from(this.#value, 'utf8');
    const b = Buffer.from(other.reveal(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
