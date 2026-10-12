import { parseArgs } from 'node:util';
import { isPlatform } from '@feedbouncer/connectors';
import { DEAD_LETTER_REASONS } from '../failure.js';
import { UUID } from '../keys.js';
import type { DeadLetterRow, DlqFilter, PgJobLedger, ReplayFilter } from '../ledger.js';
import type { JobProducer } from '../producer.js';

export const DLQ_USAGE = `Usage: pnpm jobs dlq <command>
  list   [--platform <p>] [--organization <uuid>] [--reason <r>] [--state dead_lettered|resolved]
         [--since <ISO date>] [--limit <1-500>] [--show-payload]
  replay --id <uuid> [--id <uuid> ...] [--dry-run]
  replay --platform <p> [--organization <uuid>] [--reason <r>] [--since <ISO date>]
         [--limit <1-10000>] --yes [--dry-run]`;

export class UsageError extends Error {}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type DlqCommand =
  | { cmd: 'list'; filter: DlqFilter; showPayload: boolean }
  | { cmd: 'replay'; filter: ReplayFilter; dryRun: boolean };

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_REPLAY_LIMIT = 1_000;
const MAX_REPLAY_LIMIT = 10_000;
const STATES = ['dead_lettered', 'resolved'] as const;

// Messages name the flag only: a rejected value is never echoed back.
const invalid = (flag: string): never => {
  throw new UsageError(`invalid value for --${flag}`);
};

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  return n >= 1 && n <= max ? n : invalid('limit');
}

function parseSince(raw: string): Date {
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(raw) ? d : invalid('since');
}

export function parseDlqArgs(argv: readonly string[]): DlqCommand {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch {
    throw new UsageError('unknown or malformed option');
  }
  const { values, positionals } = parsed;
  const [cmd, ...extra] = positionals;
  if ((cmd !== 'list' && cmd !== 'replay') || extra.length > 0) {
    throw new UsageError('unknown command');
  }

  const common: Omit<Writable<ReplayFilter>, 'limit'> = {};
  if (values.platform !== undefined) {
    common.platform = isPlatform(values.platform) ? values.platform : invalid('platform');
  }
  if (values.organization !== undefined) {
    common.organizationId = UUID.test(values.organization)
      ? values.organization
      : invalid('organization');
  }
  if (values.reason !== undefined) {
    const reason = DEAD_LETTER_REASONS.find((r) => r === values.reason);
    common.reason = reason ?? invalid('reason');
  }
  if (values.since !== undefined) common.since = parseSince(values.since);

  if (cmd === 'list') {
    const state =
      values.state === undefined ? 'dead_lettered' : STATES.find((s) => s === values.state);
    return {
      cmd,
      showPayload: values['show-payload'] === true,
      filter: {
        ...common,
        states: [state ?? invalid('state')],
        limit: parseLimit(values.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
      },
    };
  }

  if (values.state !== undefined || values['show-payload'] === true) {
    throw new UsageError('--state and --show-payload apply to list only');
  }
  const ids = values.id ?? [];
  if (!ids.every((i) => UUID.test(i))) invalid('id');
  if (ids.length === 0) {
    if (common.platform === undefined) throw new UsageError('bulk replay requires --platform');
    if (values.yes !== true) throw new UsageError('bulk replay requires --yes');
  }
  return {
    cmd,
    dryRun: values['dry-run'] === true,
    filter: {
      ...common,
      ...(ids.length > 0 ? { ids } : {}),
      limit: parseLimit(values.limit, DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT),
    },
  };
}

function parseOptions(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      organization: { type: 'string' },
      reason: { type: 'string' },
      state: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      'show-payload': { type: 'boolean' },
      id: { type: 'string', multiple: true },
      yes: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
}

export interface DlqDeps {
  readonly ledger: Pick<PgJobLedger, 'listDeadLetters'>;
  readonly producer: Pick<JobProducer, 'replay'>;
  readonly out: (line: string) => void;
}

function formatRow(row: DeadLetterRow, showPayload: boolean): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.scope?.organizationId,
    brandId: row.scope?.brandId,
    connectionId: row.scope?.connectionId,
    platform: row.platform,
    jobType: row.jobType,
    idempotencyKey: row.idempotencyKey,
    reason: row.reason,
    resolution: row.resolution,
    failures: row.failures,
    crashes: row.crashes,
    deferrals: row.deferrals,
    replays: row.replays,
    lastErrorKind: row.lastErrorKind,
    lastErrorCode: row.lastErrorCode,
    firstFailedAt: row.firstFailedAt,
    lastFailedAt: row.lastFailedAt,
    deadLetteredAt: row.deadLetteredAt,
    createdAt: row.createdAt,
    ...(showPayload ? { payload: row.payload } : {}),
  };
}

export async function runDlq(cmd: DlqCommand, deps: DlqDeps): Promise<number> {
  const { ledger, producer, out } = deps;
  if (cmd.cmd === 'list') {
    for (const row of await ledger.listDeadLetters(cmd.filter)) {
      out(JSON.stringify(formatRow(row, cmd.showPayload)));
    }
    return 0;
  }
  if (cmd.dryRun) {
    const rows = await ledger.listDeadLetters(
      { ...cmd.filter, states: ['dead_lettered'] },
      'oldest',
    );
    for (const row of rows) out(JSON.stringify(formatRow(row, false)));
    out(JSON.stringify({ wouldReplay: rows.length }));
    return 0;
  }
  const replayed = await producer.replay(cmd.filter);
  out(JSON.stringify({ replayed: replayed.length }));
  return 0;
}
