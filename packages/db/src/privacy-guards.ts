import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

const TX_PROBE = 'fb.tx_probe';

/**
 * Both helpers set a transaction-local setting that fb_forbid_direct_mutation()
 * honours. set_config(..., true) is reset at COMMIT or ROLLBACK, but only if a
 * transaction is open: outside one it would last for the statement alone and the
 * helper would silently do nothing, so that case is refused.
 *
 * The check is behavioural, not a timing guess: a random value is set
 * transaction-locally in one statement and read back in the next. Under
 * autocommit each statement is its own transaction, so the value is already gone.
 *
 * These helpers only guarantee transaction scope for application code. They are
 * not a security boundary: the trigger only checks that the setting is 'on', so
 * any role that can run SQL can open the hatch itself (even with a session-level SET).
 */
async function withGuardSetting<T>(
  tx: pg.PoolClient,
  setting: string,
  fn: () => Promise<T>,
): Promise<T> {
  const nonce = randomUUID();
  await tx.query('SELECT pg_catalog.set_config($1, $2, true)', [TX_PROBE, nonce]);
  const { rows } = await tx.query<{ probe: string | null }>(
    'SELECT pg_catalog.current_setting($1, true) AS probe',
    [TX_PROBE],
  );
  if (rows[0]?.probe !== nonce) throw new Error('privacy guard requires a transaction');
  await tx.query('SELECT pg_catalog.set_config($1, $2, true)', [setting, 'on']);
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
