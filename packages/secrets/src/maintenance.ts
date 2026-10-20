// Operator maintenance. These functions read across tenants by design: they
// run only from the operator CLI (never over HTTP), and each row is decrypted
// with its own organization/connection as AAD.
import { open, rewrap, type EnvelopeKind } from './envelope.js';
import { CredentialUnreadableError, type UnreadableReason } from './errors.js';
import type { KeyProvider } from './key-provider.js';
import type { Keyring } from './keyring.js';
import type { Queryable } from './credential-store.js';

export interface UnreadableRow {
  id: string;
  organizationId: string;
  connectionId: string;
  kind: string;
  reason: UnreadableReason;
}

export interface ReencryptOptions {
  dryRun: boolean;
  batchSize: number;
  signal?: AbortSignal;
  onBatch?: (progress: ReencryptReport) => void;
  /** Test seam: runs between reading a row and its compare-and-swap write. */
  beforeWrite?: (row: { id: string; connectionId: string }) => Promise<void>;
}

export interface ReencryptReport {
  scanned: number;
  rewrapped: number;
  skippedConcurrent: number;
  unreadable: UnreadableRow[];
  remainingOnOldKeys: number;
  interrupted: boolean;
}

interface SecretRow {
  id: string;
  organization_id: string;
  connection_id: string;
  kind: EnvelopeKind;
  encrypted_value: Buffer;
}

// Sealed privacy request identifiers live outside connection_secret. The key id is read from
// the envelope header (there is no column), and the bound record id is the request id.
const PRIVACY_KEY_ID = `convert_from(substring(subjects_sealed FROM 3 FOR get_byte(subjects_sealed, 1)), 'LATIN1')`;
const PRIVACY_COLUMNS = `id, organization_id, id AS connection_id, 'privacy_subject'::text AS kind,
       subjects_sealed AS encrypted_value`;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const ctxOf = (r: SecretRow) => ({
  organizationId: r.organization_id,
  connectionId: r.connection_id,
  kind: r.kind,
});
const unreadableOf = (r: SecretRow, err: CredentialUnreadableError): UnreadableRow => ({
  id: r.id,
  organizationId: r.organization_id,
  connectionId: r.connection_id,
  kind: r.kind,
  reason: err.reason,
});

async function countNotOnActive(db: Queryable, activeKeyId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM connection_secret WHERE key_id <> $1)::int
          + (SELECT count(*) FROM privacy_request
              WHERE subjects_sealed IS NOT NULL AND ${PRIVACY_KEY_ID} <> $1)::int AS n`,
    [activeKeyId],
  );
  return r.rows[0]!.n;
}

export async function reencryptAll(
  db: Queryable,
  keys: KeyProvider,
  opts: ReencryptOptions,
): Promise<ReencryptReport> {
  const report: ReencryptReport = {
    scanned: 0,
    rewrapped: 0,
    skippedConcurrent: 0,
    unreadable: [],
    remainingOnOldKeys: 0,
    interrupted: false,
  };
  const sources = [
    {
      select: `SELECT id, organization_id, connection_id, kind, encrypted_value FROM connection_secret
                WHERE key_id <> $1 AND id > $2 ORDER BY id LIMIT $3`,
      write: (row: SecretRow, next: { keyId: string; blob: Buffer }) =>
        db.query(
          'UPDATE connection_secret SET key_id = $2, encrypted_value = $3 WHERE id = $1 AND encrypted_value = $4',
          [row.id, next.keyId, next.blob, row.encrypted_value],
        ),
    },
    {
      select: `SELECT ${PRIVACY_COLUMNS} FROM privacy_request
                WHERE subjects_sealed IS NOT NULL AND ${PRIVACY_KEY_ID} <> $1 AND id > $2
                ORDER BY id LIMIT $3`,
      write: (row: SecretRow, next: { keyId: string; blob: Buffer }) =>
        db.query(
          'UPDATE privacy_request SET subjects_sealed = $2 WHERE id = $1 AND subjects_sealed = $3',
          [row.id, next.blob, row.encrypted_value],
        ),
    },
  ];
  for (const source of sources) {
    let cursor = ZERO_UUID;
    for (;;) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      const { rows } = await db.query<SecretRow>(source.select, [
        keys.activeKeyId,
        cursor,
        opts.batchSize,
      ]);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.id;
        report.scanned++;
        let next: { keyId: string; blob: Buffer };
        try {
          next = await rewrap(keys, row.encrypted_value, ctxOf(row));
        } catch (err) {
          if (!(err instanceof CredentialUnreadableError)) throw err;
          report.unreadable.push(unreadableOf(row, err));
          continue;
        }
        if (opts.dryRun) {
          report.rewrapped++;
          continue;
        }
        await opts.beforeWrite?.({ id: row.id, connectionId: row.connection_id });
        // Compare-and-swap: a concurrent token refresh wins; the next run picks the row up if it is still old.
        const u = await source.write(row, next);
        if (u.rowCount === 1) report.rewrapped++;
        else report.skippedConcurrent++;
      }
      opts.onBatch?.({ ...report });
    }
  }
  report.remainingOnOldKeys = await countNotOnActive(db, keys.activeKeyId);
  return report;
}

export async function verifyAll(
  db: Queryable,
  keys: KeyProvider,
  opts: { batchSize?: number } = {},
): Promise<{ scanned: number; unreadable: UnreadableRow[] }> {
  const out = { scanned: 0, unreadable: [] as UnreadableRow[] };
  const selects = [
    `SELECT id, organization_id, connection_id, kind, encrypted_value FROM connection_secret
      WHERE id > $1 ORDER BY id LIMIT $2`,
    `SELECT ${PRIVACY_COLUMNS} FROM privacy_request
      WHERE subjects_sealed IS NOT NULL AND id > $1 ORDER BY id LIMIT $2`,
  ];
  for (const select of selects) {
    let cursor = ZERO_UUID;
    for (;;) {
      const { rows } = await db.query<SecretRow>(select, [cursor, opts.batchSize ?? 200]);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.id;
        out.scanned++;
        try {
          await open(keys, row.encrypted_value, ctxOf(row)); // value discarded immediately
        } catch (err) {
          if (!(err instanceof CredentialUnreadableError)) throw err;
          out.unreadable.push(unreadableOf(row, err));
        }
      }
    }
  }
  return out;
}

export interface SecretsStatus {
  activeKeyId: string;
  keys: { keyId: string; configured: boolean; active: boolean; rows: number }[];
  rowsNotOnActiveKey: number;
  rowsOnUnconfiguredKeys: number;
  removableKeyIds: string[];
  connectionsNeedingReconnect: number;
  plaintextCredentialColumns: string[];
}

// Credential-like columns that are not encrypted envelopes. The NOT IN list holds the hash-only
// and non-credential columns listed in ALLOWED_CREDENTIAL_COLUMNS (conventions.integration.test.ts);
// maintenance.integration.test.ts fails if this query reports anything on the migrated schema.
const PLAINTEXT_COLUMNS_SQL = `
SELECT c.relname || '.' || a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
   AND a.attname ~ '(token|secret|password|api_key|credential)'
   AND NOT (a.attname LIKE 'encrypted\\_%' AND a.atttypid = 'bytea'::regtype)
   AND (c.relname || '.' || a.attname) NOT IN (
     'auth_account.password_hash', 'auth_session.token', 'invitation.token_hash',
     'comment_classification.input_tokens', 'comment_classification.output_tokens',
     'comment_classification.cache_read_tokens', 'policy_evaluation.input_tokens',
     'policy_evaluation.output_tokens', 'policy_evaluation.cache_read_tokens',
     'api_key.secret_sha256', 'moderation_action.actor_api_key_id',
     'api_idempotency_record.api_key_id', 'webhook_endpoint.created_by_api_key_id',
     'rule_change_proposal.proposed_by_api_key_id')
 ORDER BY 1`;

export async function secretsStatus(db: Queryable, keys: Keyring): Promise<SecretsStatus> {
  const counts = await db.query<{ key_id: string; rows: number }>(
    `SELECT key_id, count(*)::int AS rows FROM (
       SELECT key_id FROM connection_secret
       UNION ALL
       SELECT ${PRIVACY_KEY_ID} FROM privacy_request WHERE subjects_sealed IS NOT NULL
     ) k GROUP BY key_id`,
  );
  const byKey = new Map(counts.rows.map((r) => [r.key_id, r.rows]));
  const ids = new Set([...keys.keyIds(), ...byKey.keys()]);
  const list = [...ids].sort().map((keyId) => ({
    keyId,
    configured: keys.has(keyId),
    active: keyId === keys.activeKeyId,
    rows: byKey.get(keyId) ?? 0,
  }));
  const reconnect = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM connection WHERE status = 'reconnect_required' AND status_reason LIKE 'credential\\_%'",
  );
  const plaintext = await db.query<{ col: string }>(PLAINTEXT_COLUMNS_SQL);
  return {
    activeKeyId: keys.activeKeyId,
    keys: list,
    rowsNotOnActiveKey: list.filter((k) => !k.active).reduce((n, k) => n + k.rows, 0),
    rowsOnUnconfiguredKeys: list.filter((k) => !k.configured).reduce((n, k) => n + k.rows, 0),
    removableKeyIds: list
      .filter((k) => k.configured && !k.active && k.rows === 0)
      .map((k) => k.keyId),
    connectionsNeedingReconnect: reconnect.rows[0]!.n,
    plaintextCredentialColumns: plaintext.rows.map((r) => r.col),
  };
}

export interface RecheckReport {
  checked: number;
  restored: number;
  /** Some stored credential still cannot be opened with the configured keys. */
  stillUnreadable: number;
  /** Flagged connection with no stored credentials at all: only a reconnect can fix it. */
  noCredentials: number;
  /** Credentials are readable, but the pre-flag status was not recorded: left flagged, never guessed. */
  unknownPreviousStatus: number;
}

const RESTORABLE_STATUSES = ['active', 'paused', 'error'];

export async function recheckConnections(
  db: Queryable,
  keys: KeyProvider,
  opts: { dryRun: boolean },
): Promise<RecheckReport> {
  const { rows: conns } = await db.query<{ id: string; organization_id: string; brand_id: string }>(
    `SELECT id, organization_id, brand_id FROM connection
      WHERE status = 'reconnect_required' AND status_reason LIKE 'credential\\_%' ORDER BY id`,
  );
  const out: RecheckReport = {
    checked: 0,
    restored: 0,
    stillUnreadable: 0,
    noCredentials: 0,
    unknownPreviousStatus: 0,
  };
  for (const c of conns) {
    out.checked++;
    const { rows } = await db.query<SecretRow>(
      `SELECT id, organization_id, connection_id, kind, encrypted_value FROM connection_secret
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [c.organization_id, c.brand_id, c.id],
    );
    if (rows.length === 0) {
      out.noCredentials++;
      continue;
    }
    let readable = true;
    for (const row of rows) {
      try {
        await open(keys, row.encrypted_value, ctxOf(row));
      } catch (err) {
        if (!(err instanceof CredentialUnreadableError)) throw err;
        readable = false;
        break;
      }
    }
    if (!readable) {
      out.stillUnreadable++;
      continue;
    }
    // The status the connection had when it was flagged, from the latest flagging audit event.
    const prev = await db.query<{ previous_status: string | null }>(
      `SELECT details->>'previousStatus' AS previous_status FROM audit_event
        WHERE organization_id = $1 AND subject_type = 'connection' AND subject_id = $2
          AND action = 'connection.reconnect_required'
        ORDER BY sequence DESC LIMIT 1`,
      [c.organization_id, c.id],
    );
    const previous = prev.rows[0]?.previous_status ?? null;
    if (previous === null || !RESTORABLE_STATUSES.includes(previous)) {
      out.unknownPreviousStatus++;
      continue;
    }
    if (opts.dryRun) {
      out.restored++;
      continue;
    }
    const r = await db.query(
      `WITH restored AS (
         UPDATE connection SET status = $3, status_reason = NULL
          WHERE id = $1 AND organization_id = $2 AND status = 'reconnect_required' AND status_reason LIKE 'credential\\_%'
         RETURNING id, organization_id, brand_id)
       INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, details)
       SELECT organization_id, brand_id, 'system', 'connection.credentials_restored', 'connection', id,
              jsonb_build_object('status', $3::text)
         FROM restored
       RETURNING id`,
      [c.id, c.organization_id, previous],
    );
    if ((r.rowCount ?? 0) > 0) out.restored++;
  }
  return out;
}
