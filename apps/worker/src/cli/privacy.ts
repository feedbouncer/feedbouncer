import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORMS, isPlatform } from '@feedbouncer/connectors';
import { UsageError } from '@feedbouncer/jobs';
import {
  PgPrivacyRequestStore,
  SubjectList,
  loadRetentionSettings,
  processPrivacyRequest,
  type PrivacyRequestView,
  type SubjectIdentifierT,
} from '@feedbouncer/privacy';
import { loadEncryptionKeyring, type KeyProvider } from '@feedbouncer/secrets';
import { readAppEnv, type Logger } from '@feedbouncer/service-runtime';
import { readPrivacyConfig } from '../env.js';
import type { OpsCommand, Pool } from './ops-context.js';

export const PRIVACY_USAGE = [
  'usage: pnpm ops privacy export|erase --org <uuid> --as <label> [--reference <ref>]',
  '         (--platform <p> --external-id <id>... [--handle <h>...] [--connection <uuid>] | --subjects-file <path>)',
  '         erase only: [--dry-run] [--keep-rule-entries "<reason>"]',
  '       pnpm ops privacy status --org <uuid> --id <uuid>',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9._@-]{1,64}$/;

export interface PrivacyCliDeps {
  pool: Pool;
  keys: KeyProvider;
  log: Logger;
  /** Directory the command was run from; relative --subjects-file paths resolve against it. */
  cwd: string;
  exportDir: string;
  exportTtlHours: number;
  batchSize: number;
}

export interface PrivacyCliIo {
  out(line: string): void;
}

const OPTIONS = {
  org: { type: 'string' },
  id: { type: 'string' },
  platform: { type: 'string' },
  'external-id': { type: 'string', multiple: true },
  handle: { type: 'string', multiple: true },
  connection: { type: 'string' },
  reference: { type: 'string' },
  as: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'keep-rule-entries': { type: 'string' },
  'subjects-file': { type: 'string' },
} as const;

function parse(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, strict: true }).values;
  } catch {
    throw new UsageError('invalid arguments');
  }
}

async function readSubjects(
  v: ReturnType<typeof parse>,
  cwd: string,
): Promise<SubjectIdentifierT[]> {
  const file = v['subjects-file'];
  let subjects: unknown;
  if (file !== undefined) {
    if (v.platform !== undefined || v['external-id'] || v.handle || v.connection)
      throw new UsageError('--subjects-file cannot be combined with identifier flags');
    try {
      subjects = JSON.parse(await readFile(path.resolve(cwd, file), 'utf8'));
    } catch {
      throw new UsageError('--subjects-file must be a readable JSON array');
    }
  } else {
    const { platform, connection } = v;
    if (platform === undefined || !isPlatform(platform))
      throw new UsageError(`--platform must be one of: ${PLATFORMS.join(', ')}`);
    const base = { platform, ...(connection === undefined ? {} : { connectionId: connection }) };
    subjects = [
      ...(v['external-id'] ?? []).map((externalId) => ({ ...base, externalId })),
      ...(v.handle ?? []).map((handle) => ({ ...base, handle })),
    ];
  }
  const parsed = SubjectList.safeParse(subjects);
  if (!parsed.success) throw new UsageError('1 to 20 valid subject identifiers are required');
  return parsed.data;
}

function describe(r: PrivacyRequestView, exportDir: string, out: PrivacyCliIo['out']) {
  out(`request ${r.id}: ${r.kind} ${r.mode} ${r.status}`);
  if (r.errorCode !== null) out(`error: ${r.errorCode}`);
  if (r.status !== 'done') return;
  out(`found: ${r.found ? 'yes' : 'no'}`);
  for (const [k, n] of Object.entries(r.counts)) out(`${k}: ${n}`);
  if (r.coverage !== null) out(`coverage: ${r.coverage}`);
  if (r.kind === 'export')
    out(
      `file: ${path.resolve(exportDir, `${r.id}.zip`)} (expires ${r.exportExpiresAt?.toISOString() ?? '?'})`,
    );
}

/**
 * `pnpm ops privacy`. Creates the request and processes it in this process, so no Redis is
 * needed. Output carries counts and ids only, never the subject's identifiers.
 */
export async function runPrivacy(
  argv: readonly string[],
  deps: PrivacyCliDeps,
  io: PrivacyCliIo,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'export' && sub !== 'erase' && sub !== 'status')
    throw new UsageError('unknown subcommand; one of: export, erase, status');
  const v = parse(rest);
  const { org } = v;
  if (org === undefined || !UUID.test(org)) throw new UsageError('--org must be a UUID');
  const store = new PgPrivacyRequestStore(deps.pool, deps.keys);

  if (sub === 'status') {
    if (v.id === undefined || !UUID.test(v.id)) throw new UsageError('--id must be a UUID');
    const r = await store.get(org, v.id);
    if (!r) {
      io.out('request not found');
      return 1;
    }
    describe(r, deps.exportDir, io.out);
    return 0;
  }

  if (v.as === undefined || !LABEL.test(v.as))
    throw new UsageError('--as must be 1-64 letters, digits or . _ @ -');
  const erase = sub === 'erase';
  if (!erase && (v['dry-run'] || v['keep-rule-entries'] !== undefined))
    throw new UsageError('--dry-run and --keep-rule-entries apply to erase only');
  const keepReason = v['keep-rule-entries'];
  if (keepReason !== undefined && (keepReason.trim() === '' || keepReason.length > 500))
    throw new UsageError('--keep-rule-entries needs a reason of 1-500 characters');
  const subjects = await readSubjects(v, deps.cwd);

  const { id } = await store.create({
    organizationId: org,
    kind: erase ? 'erasure' : 'export',
    mode: v['dry-run'] ? 'dry_run' : 'execute',
    subjects,
    via: 'cli',
    actorUserId: null,
    actorLabel: v.as,
    reference: v.reference ?? null,
    keepRuleEntriesReason: keepReason ?? null,
  });
  await processPrivacyRequest({ store, ...deps }, id);
  const r = await store.get(org, id);
  if (!r) return 1;
  describe(r, deps.exportDir, io.out);
  return r.status === 'done' ? 0 : 1;
}

export const privacyCommand: OpsCommand = (argv, ctx) => {
  const privacy = readPrivacyConfig(ctx.env);
  return runPrivacy(
    argv,
    {
      pool: ctx.pool(),
      keys: loadEncryptionKeyring(ctx.env, readAppEnv(ctx.env), () => {}),
      log: ctx.log,
      cwd: ctx.cwd,
      exportDir: privacy.exportDir,
      exportTtlHours: privacy.exportTtlHours,
      batchSize: loadRetentionSettings(ctx.env).batchSize,
    },
    { out: ctx.out },
  );
};
