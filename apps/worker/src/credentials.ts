// The only way worker jobs should touch platform credentials. Unreadable
// credentials (unknown key, tampering) are permanent for that connection: flag
// it for reconnect, log ids and reason only, and return a handled result so
// the job completes instead of retrying or crashing the worker loop.
import {
  CredentialUnreadableError,
  markReconnectRequired,
  type ConnectionScope,
  type CredentialKind,
  type CredentialStore,
  type Queryable,
  type StoredCredential,
  type UnreadableReason,
} from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';

export type CredentialUse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: UnreadableReason };

export interface CredentialDeps {
  readonly store: Pick<CredentialStore, 'withCredentials'>;
  readonly db: Queryable;
  readonly log: Logger;
  readonly markReconnect?: typeof markReconnectRequired;
}

export async function useConnectionCredentials<T>(
  deps: CredentialDeps,
  scope: ConnectionScope,
  kinds: readonly CredentialKind[],
  fn: (creds: ReadonlyMap<CredentialKind, StoredCredential>) => Promise<T>,
): Promise<CredentialUse<T>> {
  try {
    return { ok: true, value: await deps.store.withCredentials(scope, kinds, fn) };
  } catch (err) {
    if (!(err instanceof CredentialUnreadableError)) throw err;
    const newlyFlagged = await (deps.markReconnect ?? markReconnectRequired)(deps.db, scope, err);
    deps.log.warn('connection credentials unreadable; connection marked for reconnect', {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      connectionId: scope.connectionId,
      reason: err.reason,
      keyId: err.keyId,
      newlyFlagged,
    });
    return { ok: false, reason: err.reason };
  }
}
