import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = 'feedbouncer-n8n-webhook-signing-secret-v1';

const deriveKey = (apiKey: string, salt: Buffer) => Buffer.from(hkdfSync('sha256', apiKey, salt, INFO, 32));

/**
 * Encrypts the webhook signing secret with AES-256-GCM under a key derived from the API key, which n8n keeps
 * encrypted. Workflow static data is stored in clear, so only this sealed form is kept there.
 */
export function sealSecret(secret: string, apiKey: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(apiKey, salt), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Returns undefined when the value is missing, altered or was sealed under another API key. */
export function openSecret(sealed: unknown, apiKey: string): string | undefined {
  if (typeof sealed !== 'string') return undefined;
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length <= SALT_BYTES + IV_BYTES + TAG_BYTES) return undefined;
  const salt = bytes.subarray(0, SALT_BYTES);
  const iv = bytes.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = bytes.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
  const encrypted = bytes.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(apiKey, salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
