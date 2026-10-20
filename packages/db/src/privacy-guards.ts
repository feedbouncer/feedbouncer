import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Both helpers set a transaction-local setting that fb_forbid_direct_mutation()
 * honours. set_config(..., true) is reset at COMMIT or ROLLBACK, but only if a
 * transaction is open: outside one it would last for the statement alone and the
 * helper would silently do nothing, so that case is refused.
 */
async function withGuardSetting<T>(
  tx: pg.PoolClient,
  setting: string,
  fn: () => Promise<T>,
): Promise<T> {
  // now() is the transaction start time and statement_timestamp() the current
  // statement's, so they are equal only when this statement began the transaction.
  const { rows } = await tx.query<{ autocommit: boolean }>(
    'SELECT now() = statement_timestamp() AS autocommit',
  );
  if (rows[0]?.autocommit !== false) throw new Error('privacy guard requires a transaction');
  await tx.query('SELECT set_config($1, $2, true)', [setting, 'on']);
  return fn();
}

/** Lets direct DELETEs on the append-only tables through, until the transaction ends. */
export function withRetentionDelete<T>(tx: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  return withGuardSetting(tx, 'fb.retention_delete', fn);
}

/** Lets audit_event.details be rewritten (nothing else), until the transaction ends. */
export function withPrivacyRedaction<T>(tx: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  return withGuardSetting(tx, 'fb.privacy_redaction', fn);
}

/** sha256(connectionId, NUL, externalId): identifies an erased comment without keeping any content. */
export function commentFingerprint(connectionId: string, externalId: string): Buffer {
  return createHash('sha256').update(`${connectionId}\0${externalId}`, 'utf8').digest();
}
