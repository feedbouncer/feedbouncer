import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EnvError, Secret } from '@feedbouncer/service-runtime';

/** The platform provisioning service credential: `fbp_` + 32 random bytes, base64url. */
export const PROVISIONING_TOKEN_RE = /^fbp_[A-Za-z0-9_-]{43}$/;

const DIGEST_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DIGEST_ERROR =
  'PROVISIONING_CREDENTIAL_SHA256 must be one or two comma-separated SHA-256 hex digests';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function generateProvisioningCredential(): { token: Secret; digestHex: string } {
  const token = `fbp_${randomBytes(32).toString('base64url')}`;
  return { token: new Secret(token), digestHex: sha256(token).toString('hex') };
}

/**
 * Parses PROVISIONING_CREDENTIAL_SHA256: one digest, or two while rotating.
 * Unset or blank means the provisioning API is disabled (null).
 */
export function parseCredentialDigests(raw: string | undefined): readonly Buffer[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length > 2 || !parts.every((p) => DIGEST_HEX_RE.test(p))) {
    throw new EnvError(DIGEST_ERROR);
  }
  return parts.map((p) => Buffer.from(p, 'hex'));
}

/**
 * Checks a presented token against every configured digest (no short-circuit, so
 * timing does not reveal which slot matched). The fingerprint is the first 12 hex
 * characters of the matching digest: safe to log, identifies the credential.
 */
export function matchCredential(
  token: string | undefined,
  digests: readonly Buffer[],
): { fingerprint: string } | null {
  if (token === undefined || !PROVISIONING_TOKEN_RE.test(token)) return null;
  const presented = sha256(token);
  let matched: Buffer | null = null;
  for (const digest of digests) {
    if (digest.length === presented.length && timingSafeEqual(presented, digest)) {
      matched ??= digest;
    }
  }
  return matched ? { fingerprint: matched.toString('hex').slice(0, 12) } : null;
}
