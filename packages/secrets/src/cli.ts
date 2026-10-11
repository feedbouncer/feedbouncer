// Operator CLI. stdout carries results (keygen prints only the key entry, so it
// can be piped into a secret store); stderr carries hints and errors. Never
// prints credential values or key material other than freshly generated keys.
import { randomBytes } from 'node:crypto';
import { createPool } from '@feedbouncer/db';
import {
  EnvError,
  PG_PROTOCOLS,
  errorFields,
  readAppEnv,
  readUrl,
  resolveFileEnv,
  type Env,
} from '@feedbouncer/service-runtime';
import { ENCRYPTION_FILE_VARS, loadEncryptionKeyring } from './config.js';
import { KEY_ID_PATTERN } from './key-id.js';
import {
  recheckConnections,
  reencryptAll,
  secretsStatus,
  verifyAll,
  type UnreadableRow,
} from './maintenance.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: pnpm secrets <command>
  keygen [--id <key-id>]                     print a new key entry for FB_ENCRYPTION_KEYS
  status                                     keys, credential counts, removable keys
  verify                                     decrypt every stored credential and report failures
  reencrypt [--dry-run] [--batch-size <n>]   move credentials onto the active key (resumable)
  recheck-connections [--dry-run]            restore connections whose credentials are readable again`;

class UsageError extends Error {}

type FlagKind = 'boolean' | 'value';

// Every command's accepted flags. Anything else is a usage error: a mistyped
// --dry-run must never silently turn into a real run.
const COMMAND_FLAGS: Readonly<Record<string, Readonly<Record<string, FlagKind>>>> = {
  keygen: { '--id': 'value' },
  status: {},
  verify: { '--batch-size': 'value' },
  reencrypt: { '--dry-run': 'boolean', '--batch-size': 'value' },
  'recheck-connections': { '--dry-run': 'boolean' },
};

interface ParsedFlags {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseFlags(cmd: string, args: readonly string[]): ParsedFlags {
  const allowed = COMMAND_FLAGS[cmd] ?? {};
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument "${a}"`);
    const kind = allowed[a];
    if (kind === undefined) throw new UsageError(`unknown flag ${a} for "${cmd}"`);
    if (kind === 'boolean') {
      flags.add(a);
      continue;
    }
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
    values.set(a, v);
    i++;
  }
  return { flags, values };
}

function keygen(parsed: ParsedFlags, io: CliIo): number {
  const d = new Date();
  const today = `k${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const id = parsed.values.get('--id') ?? today;
  if (!KEY_ID_PATTERN.test(id)) {
    throw new UsageError('--id must be 1-32 lowercase letters, digits or dashes');
  }
  io.out(`${id}:${randomBytes(32).toString('base64')}`);
  io.err(
    'Add this entry to FB_ENCRYPTION_KEYS on every API and worker first; make it active only after all of them restarted.',
  );
  io.err('Back it up in your secret manager, separately from database backups.');
  return 0;
}

function printUnreadable(rows: UnreadableRow[], io: CliIo): void {
  for (const r of rows) {
    io.out(
      `unreadable: connection ${r.connectionId} (organization ${r.organizationId}) ${r.kind}: ${r.reason}`,
    );
  }
}

export async function main(
  argv: readonly string[],
  rawEnv: Env,
  io: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    if (cmd !== undefined && !Object.hasOwn(COMMAND_FLAGS, cmd)) {
      throw new UsageError(`unknown command "${cmd}"`);
    }
    if (cmd === undefined) throw new UsageError('missing command');
    const parsed = parseFlags(cmd, args);
    if (cmd === 'keygen') return keygen(parsed, io);
    const batchRaw = parsed.values.get('--batch-size') ?? '100';
    const batchSize = /^\d+$/.test(batchRaw) ? Number(batchRaw) : Number.NaN;
    if (!(batchSize >= 1 && batchSize <= 1000)) {
      throw new UsageError('--batch-size must be an integer between 1 and 1000');
    }
    const dryRun = parsed.flags.has('--dry-run');

    const env = resolveFileEnv(rawEnv, ['DATABASE_URL', ...ENCRYPTION_FILE_VARS]);
    const appEnv = readAppEnv(env);
    const databaseUrl = readUrl(env, 'DATABASE_URL', PG_PROTOCOLS);
    const keys = loadEncryptionKeyring(env, appEnv, (m) => io.err(`warning: ${m}`));
    const pool = createPool(databaseUrl, {
      applicationName: 'feedbouncer-secrets-cli',
      max: 2,
      onIdleError: () => {},
    });
    try {
      if (cmd === 'status') {
        const s = await secretsStatus(pool, keys);
        io.out(`active key: ${s.activeKeyId}`);
        for (const k of s.keys) {
          if (!k.configured) {
            io.out(
              `key ${k.keyId} (NOT CONFIGURED): ${k.rows} credentials. Restore this key or those connections must reconnect.`,
            );
          } else if (k.active) {
            io.out(`key ${k.keyId} (active): ${k.rows} credentials`);
          } else {
            const hint = k.rows === 0 ? ', safe to remove' : ', run: pnpm secrets reencrypt';
            io.out(`key ${k.keyId} (retired): ${k.rows} credentials${hint}`);
          }
        }
        io.out(`credentials not on the active key: ${s.rowsNotOnActiveKey}`);
        io.out(`connections needing reconnect: ${s.connectionsNeedingReconnect}`);
        const cols = s.plaintextCredentialColumns;
        io.out(
          `plaintext credential columns: ${cols.length}${cols.length ? ` (${cols.join(', ')})` : ''}`,
        );
        return s.rowsOnUnconfiguredKeys > 0 || cols.length > 0 ? 1 : 0;
      }
      if (cmd === 'verify') {
        const r = await verifyAll(pool, keys, { batchSize });
        printUnreadable(r.unreadable, io);
        io.out(`verified ${r.scanned} credentials, ${r.unreadable.length} unreadable`);
        return r.unreadable.length === 0 ? 0 : 1;
      }
      if (cmd === 'reencrypt') {
        io.out(`re-encrypting to active key ${keys.activeKeyId}`);
        const r = await reencryptAll(pool, keys, {
          dryRun,
          batchSize,
          ...(signal ? { signal } : {}),
          onBatch: (p) =>
            io.err(
              `progress: scanned ${p.scanned}, ${dryRun ? 'would rewrap' : 'rewrapped'} ${p.rewrapped}`,
            ),
        });
        printUnreadable(r.unreadable, io);
        io.out(
          `${dryRun ? 'dry run: would rewrap' : 'rewrapped'} ${r.rewrapped} of ${r.scanned} scanned; skipped (changed concurrently) ${r.skippedConcurrent}; unreadable ${r.unreadable.length}`,
        );
        io.out(`credentials not on the active key: ${r.remainingOnOldKeys}`);
        if (r.interrupted) io.out('interrupted; run the same command again to continue');
        return r.remainingOnOldKeys === 0 && r.unreadable.length === 0 ? 0 : 1;
      }
      const r = await recheckConnections(pool, keys, { dryRun });
      io.out(
        `checked ${r.checked} flagged connections; ${dryRun ? 'would restore' : 'restored'} ${r.restored}`,
      );
      io.out(`still unreadable with the configured keys: ${r.stillUnreadable}`);
      io.out(`no stored credentials (reconnect required): ${r.noCredentials}`);
      io.out(`previous status not recorded (left flagged): ${r.unknownPreviousStatus}`);
      return r.stillUnreadable + r.noCredentials + r.unknownPreviousStatus === 0 ? 0 : 1;
    } finally {
      await pool.end();
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message);
      io.err(USAGE);
      return 2;
    }
    if (err instanceof EnvError) {
      io.err(err.message);
      return 1;
    }
    io.err(`secrets ${cmd ?? ''} failed: ${errorFields(err).errorMessage ?? 'unknown error'}`);
    return 1;
  }
}
