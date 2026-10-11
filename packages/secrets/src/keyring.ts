import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { CredentialUnreadableError } from './errors.js';
import { KEY_ID_PATTERN } from './key-id.js';
import type { KeyProvider } from './key-provider.js';

export { KEY_ID_PATTERN };
export const KEY_BYTES = 32;
export const MAX_KEYS = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = IV_BYTES + KEY_BYTES + TAG_BYTES; // iv | ct | tag

/** Deployment key-encryption keys. Material lives in a #private map and is never serialized. */
export class Keyring implements KeyProvider {
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(
    keys: ReadonlyMap<string, Buffer>,
    readonly activeKeyId: string,
  ) {
    if (keys.size === 0 || keys.size > MAX_KEYS) throw new Error('keyring needs 1..16 keys');
    for (const [id, k] of keys) {
      if (!KEY_ID_PATTERN.test(id) || k.length !== KEY_BYTES)
        throw new Error('invalid keyring entry');
    }
    if (!keys.has(activeKeyId)) throw new Error('active key must be in the keyring');
    this.#keys = new Map([...keys].map(([id, k]) => [id, Buffer.from(k)]));
  }

  has(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: Buffer }> {
    const key = this.#keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { keyId: this.activeKeyId, wrapped: Buffer.concat([iv, ct, cipher.getAuthTag()]) };
  }

  async unwrap(keyId: string, wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const key = this.#keys.get(keyId);
    if (!key) throw new CredentialUnreadableError('unknown_key', keyId);
    if (wrapped.length !== WRAPPED_BYTES) throw new CredentialUnreadableError('malformed', keyId);
    const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(wrapped.subarray(IV_BYTES + KEY_BYTES));
    try {
      return Buffer.concat([
        decipher.update(wrapped.subarray(IV_BYTES, IV_BYTES + KEY_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new CredentialUnreadableError('tampered', keyId);
    }
  }

  toJSON(): { activeKeyId: string; keyIds: string[] } {
    return { activeKeyId: this.activeKeyId, keyIds: this.keyIds() };
  }

  [inspect.custom](): string {
    return `Keyring(active=${this.activeKeyId}, keys=${this.keyIds().join(',')})`;
  }
}
