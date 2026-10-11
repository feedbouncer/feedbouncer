import {
  EnvError,
  checkNotPlaceholder,
  readRequiredString,
  readSecret,
  type AppEnv,
  type Env,
} from '@feedbouncer/service-runtime';
import { KEY_BYTES, KEY_ID_PATTERN, Keyring, MAX_KEYS } from './keyring.js';

/** Settings that may instead be supplied as <NAME>_FILE (see resolveFileEnv). */
export const ENCRYPTION_FILE_VARS = ['FB_ENCRYPTION_KEYS'] as const;

const CANONICAL_B64_32 = /^[A-Za-z0-9+/]{43}=$/;
// 32 random bytes have ~31 distinct values; fewer than 16 is overwhelmingly a typo or a pattern.
const MIN_DISTINCT_BYTES = 16;
const KEYGEN_HINT = 'Generate one with: pnpm secrets keygen';

export function loadEncryptionKeyring(
  env: Env,
  appEnv: AppEnv,
  warn: (msg: string) => void,
): Keyring {
  // minLength 1: presence only; the per-entry checks below give the precise error.
  const raw = readSecret(env, 'FB_ENCRYPTION_KEYS', { minLength: 1 });
  const activeKeyId = readRequiredString(env, 'FB_ENCRYPTION_ACTIVE_KEY_ID', {
    maxLength: 32,
    pattern: KEY_ID_PATTERN,
  });
  const entries = raw.split(',').map((e) => e.trim());
  if (entries.length > MAX_KEYS)
    throw new EnvError(`FB_ENCRYPTION_KEYS has more than ${MAX_KEYS} keys.`);

  const keys = new Map<string, Buffer>();
  const materials = new Set<string>();
  entries.forEach((entry, i) => {
    const n = i + 1;
    const sep = entry.indexOf(':');
    if (sep <= 0) {
      throw new EnvError(
        `FB_ENCRYPTION_KEYS entry ${n} must look like <key-id>:<base64 key> (value not shown).`,
      );
    }
    const id = entry.slice(0, sep);
    const b64 = entry.slice(sep + 1);
    if (!KEY_ID_PATTERN.test(id)) {
      throw new EnvError(
        `FB_ENCRYPTION_KEYS entry ${n} has an invalid key id: use 1-32 lowercase letters, digits or dashes (value not shown).`,
      );
    }
    if (keys.has(id)) throw new EnvError(`FB_ENCRYPTION_KEYS lists key id "${id}" more than once.`);
    if (!CANONICAL_B64_32.test(b64)) {
      throw new EnvError(
        `FB_ENCRYPTION_KEYS key "${id}" must be exactly ${KEY_BYTES} random bytes in standard base64 (44 characters ending in "="). ${KEYGEN_HINT}`,
      );
    }
    const key = Buffer.from(b64, 'base64');
    if (new Set(key).size < MIN_DISTINCT_BYTES) {
      throw new EnvError(`FB_ENCRYPTION_KEYS key "${id}" has too little entropy. ${KEYGEN_HINT}`);
    }
    if (materials.has(b64))
      throw new EnvError('FB_ENCRYPTION_KEYS uses the same key material under two key ids.');
    materials.add(b64);
    checkNotPlaceholder(appEnv, `FB_ENCRYPTION_KEYS key "${id}"`, b64, warn);
    keys.set(id, key);
  });

  if (!keys.has(activeKeyId)) {
    throw new EnvError(
      'FB_ENCRYPTION_ACTIVE_KEY_ID names a key id that is not in FB_ENCRYPTION_KEYS.',
    );
  }
  const ring = new Keyring(keys, activeKeyId);
  for (const k of keys.values()) k.fill(0);
  return ring;
}
