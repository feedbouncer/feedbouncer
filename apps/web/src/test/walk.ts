import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Recursive, sorted list of files under `dir` with one of `exts` (e.g. `.tsx`), excluding `*.test.*`. */
export function walk(dir: string, exts: string[]): string[] {
  const files = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, exts);
    return exts.some((ext) => entry.name.endsWith(ext)) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
  return files.sort();
}
