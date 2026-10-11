// Errors that are safe to log and to show an operator: they carry a reason
// code and, when it is well-formed, the (non-secret) key id. Never a value.
import { KEY_ID_PATTERN } from './key-id.js';

export type UnreadableReason = 'unknown_key' | 'tampered' | 'malformed';

const MESSAGES: Record<UnreadableReason, (keyId: string | null) => string> = {
  unknown_key: (id) =>
    `Stored credential was encrypted with key id "${id}", which is not configured in FB_ENCRYPTION_KEYS. Restore that key, or reconnect the connection.`,
  tampered: () =>
    'Stored credential failed its integrity check (tampered, truncated, or bound to a different record). Reconnect the connection.',
  malformed: () => 'Stored credential is not in a recognized format. Reconnect the connection.',
};

export class CredentialUnreadableError extends Error {
  override name = 'CredentialUnreadableError';
  readonly keyId: string | null;
  constructor(
    readonly reason: UnreadableReason,
    keyId: string | null,
  ) {
    const safeId = keyId !== null && KEY_ID_PATTERN.test(keyId) ? keyId : null;
    super(MESSAGES[reason](safeId));
    this.keyId = safeId;
  }
}

export class ConnectionNotFoundError extends Error {
  override name = 'ConnectionNotFoundError';
  constructor() {
    super('Connection not found in this organization and brand.');
  }
}
