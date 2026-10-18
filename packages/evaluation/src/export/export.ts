import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { UsageError, deriveIdempotencyKey } from '@feedbouncer/jobs';
import { EXECUTE_JOB, INGEST_JOB } from '@feedbouncer/comments';
import { RUN_SCHEMA_VERSION } from '../constants.js';
import { createRunDir, labelSheetCsv, writeRunFile, type LabelSheetRow } from '../io.js';
import type { EvalItem, RunManifest } from '../schema.js';
import { deriveItem, pseudonymiser, type CommentFacts, type LedgerFact } from './derive.js';
import { samplePermutation } from './sample.js';
import {
  PAGE_SIZE,
  brandsInOrgs,
  bytesPerComment,
  commentsPage,
  ledgersByKey,
  relatedRows,
  ruleKinds,
  type Cursor,
} from './sql.js';

export type ExportOptions = {
  organizationIds: string[];
  brandIds: string[];
  from: Date;
  to: Date;
  labelSample: number | null;
  seed: number;
  out: string;
  now: Date;
  jobRetentionDays: number;
};

const DAY_MS = 86_400_000;

/** Exports a run with a fresh random salt that lives only in this process's memory. */
export function exportRun(pool: pg.Pool, o: ExportOptions): Promise<RunManifest> {
  return exportRunWithSalt(pool, o, randomBytes(32));
}

/** As `exportRun`, with a caller-supplied salt (tests only: it makes pseudonyms predictable). */
export async function exportRunWithSalt(
  pool: pg.Pool,
  o: ExportOptions,
  salt: Buffer,
): Promise<RunManifest> {
  if (o.organizationIds.length === 0) throw new UsageError('at least one organization is required');
  if (o.brandIds.length > 0) {
    const found = await brandsInOrgs(pool, o.organizationIds, o.brandIds);
    if (o.brandIds.some((b) => !found.has(b))) throw new UsageError('brand not in organization');
  }
  await createRunDir(o.out);

  const pseudonym = pseudonymiser(salt);
  const scope = { orgs: o.organizationIds, brands: o.brandIds, from: o.from, to: o.to };
  const retentionCutoff = o.now.getTime() - o.jobRetentionDays * DAY_MS;

  const items: EvalItem[] = [];
  const sheet = new Map<string, LabelSheetRow>();
  const promptVersions = new Set<string>();
  let excludedAuthorDeleted = 0;
  let timingUnavailableBeforeRetention = 0;

  let cursor: Cursor = null;
  for (;;) {
    const page = await commentsPage(pool, scope, cursor);
    if (page.length === 0) break;
    const ids = page.map((c) => c.id);
    const rel = await relatedRows(pool, o.organizationIds, ids);

    const ruleIds = new Set<string>();
    for (const list of rel.actions.values())
      for (const a of list) if (a.ruleId) ruleIds.add(a.ruleId);
    const kinds = await ruleKinds(pool, o.organizationIds, [...ruleIds]);

    // Ledger rows are looked up by computed key: the ingest key per comment, and the exec key
    // per hide/delete action.
    const keyOf = (c: (typeof page)[number], type: string, externalRef: string): string =>
      deriveIdempotencyKey({
        scope: {
          organizationId: c.organizationId,
          brandId: c.brandId,
          connectionId: c.connectionId,
        },
        platform: c.platform,
        type,
        externalRef,
      });
    const ingestKey = new Map<string, string>();
    const execKeys = new Map<string, string>(); // action id -> key
    for (const c of page) {
      ingestKey.set(
        c.id,
        keyOf(
          c,
          INGEST_JOB.type,
          INGEST_JOB.externalRef({
            sourceExternalId: '',
            commentExternalId: c.externalId,
            event: 'created',
            platformEventSec: 1,
            changeId: '',
          }),
        ),
      );
      for (const a of rel.actions.get(c.id) ?? [])
        if (a.kind === 'hide' || a.kind === 'delete')
          execKeys.set(
            a.id,
            keyOf(c, EXECUTE_JOB.type, EXECUTE_JOB.externalRef({ actionId: a.id })),
          );
    }
    const ledgers = await ledgersByKey(pool, o.organizationIds, [
      ...ingestKey.values(),
      ...execKeys.values(),
    ]);
    const ledgerFact = (key: string | undefined): LedgerFact | null => {
      const h = key ? ledgers.get(key) : undefined;
      if (!h) return null;
      return h;
    };

    for (const c of page) {
      const actions = rel.actions.get(c.id) ?? [];
      const execLedgers = new Map<string, LedgerFact>();
      for (const a of actions) {
        const l = ledgerFact(execKeys.get(a.id));
        if (l) execLedgers.set(a.id, l);
      }
      const sug = rel.suggestions.get(c.id)?.[0] ?? null;
      const facts: CommentFacts = {
        commentId: c.id,
        bodyNow: c.body,
        platformState: c.platformState,
        postedAt: c.postedAt,
        ingestedAt: c.ingestedAt,
        origin: c.origin,
        platform: c.platform,
        actions,
        ingestLedger: ledgerFact(ingestKey.get(c.id)),
        execLedgers,
        ruleEvals: rel.ruleEvals.get(c.id) ?? [],
        classifications: rel.classifications.get(c.id) ?? [],
        policyEvals: rel.policyEvals.get(c.id) ?? [],
        decisions: rel.decisions.get(c.id) ?? [],
        suggestion: sug
          ? {
              status: sug.status,
              createdAt: sug.createdAt,
              decidedAt: sug.decidedAt,
              sourceType: sug.sourceType,
            }
          : null,
        ruleKindById: kinds,
      };
      const item = deriveItem(facts, pseudonym);
      if (item === 'author_deleted') {
        excludedAuthorDeleted++;
        continue;
      }
      items.push(item);
      if (item.outcome === 'hidden' && c.postedAt.getTime() < retentionCutoff)
        timingUnavailableBeforeRetention++;
      for (const x of facts.classifications)
        if (x.promptVersion) promptVersions.add(x.promptVersion);
      for (const x of facts.policyEvals) if (x.promptVersion) promptVersions.add(x.promptVersion);
      if (item.judgedVersionAvailable)
        sheet.set(item.item, { item: item.item, platform: c.platform, text: c.body });
    }

    const last = page[page.length - 1]!;
    cursor = { postedAtKey: last.postedAtKey, id: last.id };
    if (page.length < PAGE_SIZE) break;
  }

  items.sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  const sheetItems = [...sheet.values()].sort((a, b) => (a.item < b.item ? -1 : 1));
  const permuted = samplePermutation(sheetItems, o.seed);
  const labelRows = o.labelSample === null ? permuted : permuted.slice(0, o.labelSample);

  const manifest: RunManifest = {
    runSchemaVersion: RUN_SCHEMA_VERSION,
    exportedAt: o.now.toISOString(),
    window: { from: o.from.toISOString(), to: o.to.toISOString() },
    brandsScoped: o.brandIds.length > 0,
    itemCount: items.length,
    labelSheetCount: labelRows.length,
    sample: o.labelSample === null ? null : { size: o.labelSample, seed: o.seed },
    excludedAuthorDeleted,
    timingUnavailableBeforeRetention,
    bytesPerComment: await bytesPerComment(pool),
    promptVersions: [...promptVersions].sort(),
    jobRetentionDays: o.jobRetentionDays,
  };

  await writeRunFile(o.out, 'items.jsonl', items.map((i) => `${JSON.stringify(i)}\n`).join(''));
  await writeRunFile(o.out, 'label-sheet.csv', labelSheetCsv(labelRows));
  await writeRunFile(o.out, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
