import { parseArgs } from 'node:util';
import {
  DEFAULT_BACKLOG_CAP,
  PgBackfillStore,
  PgYouTubeBacklog,
  enqueueLifecycle,
  revokeConnection,
} from '@feedbouncer/comments';
import { PgConnectionDirectory, systemClock } from '@feedbouncer/connectors';
import { deleteOrganization, withTransaction } from '@feedbouncer/db';
import { UsageError } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { OpsCommand, OpsContext, Pool } from './ops-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;

export const ERASE_ORG_USAGE =
  'usage: pnpm ops erase-org --org <uuid> --confirm "<org name>" [--delete-orphan-users]';

type EraseErrorCode = 'confirmation_mismatch' | 'teardown_timeout' | 'connections_active';

export class EraseError extends Error {
  constructor(readonly code: EraseErrorCode) {
    super(code);
  }
}

export interface EraseOrgDeps {
  pool: Pool;
  disconnect: (scope: ConnectionScope) => Promise<void>;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface EraseOrgInput {
  organizationId: string;
  confirmName: string;
  deleteOrphanUsers: boolean;
  timeoutMs?: number;
}

export interface EraseOrgResult {
  connectionsDisconnected: number;
  usersDeleted: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Disconnects every live connection, waits for the platform teardown to delete
 * the stored credentials, then deletes the organization (and optionally the
 * users who belonged to no other one). Nothing is deleted if teardown stalls.
 */
export async function eraseOrg(deps: EraseOrgDeps, input: EraseOrgInput): Promise<EraseOrgResult> {
  const { pool, log } = deps;
  const { organizationId } = input;
  const sleep = deps.sleep ?? wait;
  const org = UUID.test(organizationId)
    ? (
        await pool.query<{ name: string }>('SELECT name FROM organization WHERE id = $1', [
          organizationId,
        ])
      ).rows[0]
    : undefined;
  if (org?.name !== input.confirmName) throw new EraseError('confirmation_mismatch');

  const live = await pool.query<{ id: string; brand_id: string }>(
    `SELECT id, brand_id FROM connection
      WHERE organization_id = $1
        AND (status <> 'revoked'
             OR EXISTS (SELECT 1 FROM connection_secret s WHERE s.connection_id = connection.id))`,
    [organizationId],
  );
  for (const c of live.rows)
    await deps.disconnect({ organizationId, brandId: c.brand_id, connectionId: c.id });
  log.info('erase-org: connections disconnected', { organizationId, count: live.rowCount });

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let waited = 0; ; waited += POLL_MS) {
    const left = await pool.query(
      `SELECT 1 FROM connection_secret s JOIN connection c ON c.id = s.connection_id
        WHERE c.organization_id = $1 LIMIT 1`,
      [organizationId],
    );
    if (left.rowCount === 0) break;
    if (waited >= timeoutMs) throw new EraseError('teardown_timeout');
    await sleep(POLL_MS);
  }

  const usersDeleted = await withTransaction(pool, async (c) => {
    const members = await c.query<{ user_id: string }>(
      'SELECT user_id FROM membership WHERE organization_id = $1',
      [organizationId],
    );
    const result = await deleteOrganization(c, organizationId, input.confirmName);
    if (result !== 'deleted') throw new EraseError('connections_active');
    if (!input.deleteOrphanUsers) return 0;
    const orphans = await c.query(
      `DELETE FROM app_user u WHERE u.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.user_id = u.id)`,
      [members.rows.map((m) => m.user_id)],
    );
    return orphans.rowCount ?? 0;
  });
  log.info('erase-org: organization erased', { organizationId, usersDeleted });
  return { connectionsDisconnected: live.rowCount ?? 0, usersDeleted };
}

/** Parses the command line, erases, and prints counts and ids only. Returns the exit code. */
export async function runEraseOrg(
  argv: readonly string[],
  deps: EraseOrgDeps,
  out: (line: string) => void,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        org: { type: 'string' },
        confirm: { type: 'string' },
        'delete-orphan-users': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch {
    throw new UsageError('invalid arguments');
  }
  if (values.org === undefined || values.confirm === undefined)
    throw new UsageError('--org and --confirm are required');
  const r = await eraseOrg(deps, {
    organizationId: values.org,
    confirmName: values.confirm,
    deleteOrphanUsers: values['delete-orphan-users'],
  });
  out(
    `erased organization ${values.org}: connections_disconnected=${r.connectionsDisconnected} users_deleted=${r.usersDeleted}`,
  );
  return 0;
}

/** Disconnects as the operator: same local revoke and teardown enqueue as a user's disconnect. */
export function operatorDisconnect(ctx: OpsContext): EraseOrgDeps['disconnect'] {
  const pool = ctx.pool();
  const directory = new PgConnectionDirectory(pool);
  const backfill = new PgBackfillStore(pool);
  // The organization is being erased, so the abandoned actions need no outcome observers.
  const backlog = new PgYouTubeBacklog({
    pool,
    clock: systemClock,
    cap: DEFAULT_BACKLOG_CAP,
    log: ctx.log,
  });
  return async (scope) => {
    const rec = await directory.load(scope);
    if (!rec) return;
    const revoked = await revokeConnection(
      { pool, directory, backfill, backlog, log: ctx.log },
      scope,
      null,
    );
    if (revoked) {
      const retryKey = `erase-org:${scope.connectionId}:${Date.now()}`;
      await enqueueLifecycle(pool, ctx.producer(), scope, rec.platform, 'teardown', retryKey);
    }
  };
}

export const eraseOrgCommand: OpsCommand = (argv, ctx) =>
  runEraseOrg(
    argv,
    { pool: ctx.pool(), disconnect: operatorDisconnect(ctx), log: ctx.log },
    ctx.out,
  );
