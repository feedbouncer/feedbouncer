import { readFileSync } from 'node:fs';

/** The custom properties declared in the file's first `:root` block, lower-cased and trimmed. */
export function readCssVars(file: string): Record<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  const vars: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    vars[name!] = value!.trim().toLowerCase();
  return vars;
}
