import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretLike } from '../../../../scripts/ci/lib/secret-patterns.mjs';

export const appRoot = resolve(fileURLToPath(import.meta.url), '../../..');
export const repoRoot = resolve(appRoot, '../..');

export { findSecretLike };

export const FEEDBOUNCER_KEY_RE = /fbk_[a-z2-7]{16}_[A-Za-z0-9_-]{43}/;

const CONTENT_ROOTS = ['docs', 'versioned_docs'];
const EXCLUDED = /(^|\/)(_generated|api\/reference)(\/|$)/;

/** Absolute paths of every hand-written page, excluding generated content. */
export function docFiles(): string[] {
  return CONTENT_ROOTS.flatMap((root) => {
    const dir = join(appRoot, root);
    try {
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && /\.mdx?$/.test(e.name))
        .map((e) => join(e.parentPath, e.name))
        .filter((f) => !EXCLUDED.test(f.slice(dir.length + 1)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }).sort();
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/** The top-level `key: value` pairs of a page's front matter. */
export function frontMatter(file: string): Record<string, string> {
  const block = FRONT_MATTER.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  const entries = block.split('\n').flatMap((line) => {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    return m ? [[m[1]!, m[2]!.replace(/^(["'])(.*)\1$/, '$2')] as const] : [];
  });
  return Object.fromEntries(entries);
}

/** The page body, without front matter. */
export const body = (file: string): string => readFileSync(file, 'utf8').replace(FRONT_MATTER, '');

const FENCE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;

export function codeBlocks(md: string): { lang: string; body: string }[] {
  return [...md.matchAll(FENCE)].map((m) => ({
    lang: m[2]!.trim().split(/[\s{]/)[0]!,
    body: m[3]!,
  }));
}

const withoutCode = (md: string) => md.replace(FENCE, '').replace(/`[^`\n]*`/g, '');

export function headings(md: string): { depth: number; text: string }[] {
  // Only fences are stripped: a heading may itself hold inline code, such as "### `hide`".
  return [...md.replace(FENCE, '').matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => ({
    depth: m[1]!.length,
    text: m[2]!,
  }));
}

/** Every http(s) URL and markdown link target outside code. */
export function links(md: string): string[] {
  const text = withoutCode(md);
  const targets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]!);
  const hrefs = [...text.matchAll(/\bhref=["']([^"']+)["']/g)].map((m) => m[1]!);
  const bare = [...text.matchAll(/https?:\/\/[^\s)<>"'\]]+/g)].map((m) => m[0]);
  return [...new Set([...targets, ...hrefs, ...bare])];
}
