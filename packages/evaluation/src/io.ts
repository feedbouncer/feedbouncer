import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import type { ZodType } from 'zod';
import { MAX_CSV_RECORD_BYTES, MAX_INPUT_FILE_BYTES } from './constants.js';
import { EvalItem, LabelRow, MetaConfig, MetaRow, Pricing, RunManifest } from './schema.js';

/** A problem with a user-supplied input file. Messages never contain cell or line content. */
export class InputError extends Error {
  constructor(
    readonly file: string,
    readonly where: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${file}: ${where}: ${field}: ${reason}`);
    this.name = 'InputError';
  }
}

export type RunInputs = {
  manifest: RunManifest;
  items: EvalItem[];
  labels: LabelRow[];
  meta: MetaRow[] | null;
  metaConfig: MetaConfig | null;
  pricing: Pricing | null;
  inputDigests: { file: string; sha256: string }[];
};

type Reader = {
  dir: string;
  digests: Map<string, string>;
};

async function statOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Reads a regular, size-limited file; returns null when absent and optional. */
async function readInput(r: Reader, rel: string, optional: boolean): Promise<Buffer | null> {
  const st = await statOrNull(join(r.dir, rel));
  if (!st) {
    if (optional) return null;
    throw new InputError(rel, 'file', 'file', 'missing');
  }
  if (!st.isFile()) throw new InputError(rel, 'file', 'file', 'not a regular file');
  if (st.size > MAX_INPUT_FILE_BYTES) throw new InputError(rel, 'file', 'file', 'file too large');
  const buf = await readFile(join(r.dir, rel));
  if (buf.length > MAX_INPUT_FILE_BYTES)
    throw new InputError(rel, 'file', 'file', 'file too large');
  r.digests.set(rel, createHash('sha256').update(buf).digest('hex'));
  return buf;
}

function fieldOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(record)' : path.map(String).join('.');
}

function validate<T>(schema: ZodType<T>, value: unknown, file: string, where: string): T {
  const res = schema.safeParse(value);
  if (res.success) return res.data;
  const issue = res.error.issues[0]!;
  throw new InputError(file, where, fieldOf(issue.path), `invalid (${issue.code})`);
}

function parseJson(buf: Buffer, file: string, where: string): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new InputError(file, where, '(record)', 'not valid JSON');
  }
}

/**
 * Parses a CSV into objects limited to `known` columns. `columns: true` is deliberately not
 * used (prototype-replacement advisory); the header row is mapped by hand. Empty cells are
 * treated as absent. Row numbers count the header as row 1.
 */
function readCsv<T>(buf: Buffer, file: string, known: readonly string[], schema: ZodType<T>): T[] {
  let records: string[][];
  try {
    records = parse(buf, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      max_record_size: MAX_CSV_RECORD_BYTES,
    }) as string[][];
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new InputError(
      file,
      'csv',
      '(record)',
      `malformed CSV${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  const header = records[0];
  if (!header) throw new InputError(file, 'row 1', '(header)', 'missing header row');
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) throw new InputError(file, 'row 1', '(header)', 'duplicate column name');
    seen.add(name);
  }
  const knownSet = new Set(known);
  const wanted = new Map<number, string>();
  header.forEach((name, idx) => {
    if (knownSet.has(name)) wanted.set(idx, name);
  });
  const out: T[] = [];
  records.slice(1).forEach((rec, i) => {
    const obj: Record<string, string> = {};
    for (const [idx, name] of wanted) {
      const cell = rec[idx];
      if (cell !== undefined && cell !== '')
        Object.defineProperty(obj, name, {
          value: cell,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    out.push(validate(schema, obj, file, `row ${i + 2}`));
  });
  return out;
}

export async function readRun(dir: string): Promise<RunInputs> {
  const r: Reader = { dir, digests: new Map() };

  const manifestBuf = (await readInput(r, 'manifest.json', false))!;
  const manifest = validate(
    RunManifest,
    parseJson(manifestBuf, 'manifest.json', 'file'),
    'manifest.json',
    'file',
  );

  const itemsBuf = (await readInput(r, 'items.jsonl', false))!;
  const items: EvalItem[] = [];
  const seenIds = new Set<string>();
  itemsBuf
    .toString('utf8')
    .split(/\r?\n/)
    .forEach((text, i) => {
      if (text.trim() === '') return;
      const where = `line ${i + 1}`;
      const item = validate(
        EvalItem,
        parseJson(Buffer.from(text), 'items.jsonl', where),
        'items.jsonl',
        where,
      );
      if (seenIds.has(item.item))
        throw new InputError('items.jsonl', where, 'item', 'duplicate item id');
      seenIds.add(item.item);
      items.push(item);
    });

  const labels: LabelRow[] = [];
  const labelsDir = await statOrNull(join(dir, 'labels'));
  if (labelsDir) {
    if (!labelsDir.isDirectory()) throw new InputError('labels', 'file', 'file', 'not a directory');
    const names = (await readdir(join(dir, 'labels'))).filter((n) => n.endsWith('.csv')).sort();
    for (const name of names) {
      const rel = `labels/${name}`;
      const buf = (await readInput(r, rel, false))!;
      labels.push(
        ...readCsv(buf, rel, ['item', 'labeller', 'verdict', 'category', 'role'], LabelRow),
      );
    }
  }

  const metaBuf = await readInput(r, 'meta.csv', true);
  const metaConfigBuf = await readInput(r, 'meta-config.json', true);
  if (metaBuf && !metaConfigBuf) {
    throw new InputError('meta-config.json', 'file', 'file', 'missing (required with meta.csv)');
  }
  const meta = metaBuf
    ? readCsv(metaBuf, 'meta.csv', ['item', 'meta_outcome', 'note'], MetaRow)
    : null;
  const metaConfig = metaConfigBuf
    ? validate(
        MetaConfig,
        parseJson(metaConfigBuf, 'meta-config.json', 'file'),
        'meta-config.json',
        'file',
      )
    : null;

  const pricingBuf = await readInput(r, 'pricing.json', true);
  const pricing = pricingBuf
    ? validate(Pricing, parseJson(pricingBuf, 'pricing.json', 'file'), 'pricing.json', 'file')
    : null;

  const inputDigests = [...r.digests]
    .map(([file, sha256]) => ({ file, sha256 }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return { manifest, items, labels, meta, metaConfig, pricing, inputDigests };
}
