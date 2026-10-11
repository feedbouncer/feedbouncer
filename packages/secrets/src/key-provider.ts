/**
 * Wraps per-record data keys (DEKs). Keyring implements it from env config. A
 * cloud KMS or Vault adapter can implement it later without changing the
 * envelope format (the envelope records the wrapped length). unwrap must
 * throw CredentialUnreadableError ('unknown_key' | 'tampered' | 'malformed').
 */
export interface KeyProvider {
  readonly activeKeyId: string;
  has(keyId: string): boolean;
  wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: Buffer }>;
  unwrap(keyId: string, wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}
