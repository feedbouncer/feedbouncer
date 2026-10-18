const ESCAPED = new Set([...'\\`*_{}[]()#+-.!|']);

/** Escapes Markdown syntax in untrusted text; angle brackets become entities, newlines spaces. */
export function escapeMd(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\n' || ch === '\r') out += ' ';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else out += ESCAPED.has(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      Object.defineProperty(out, k, {
        value: sortKeys((v as Record<string, unknown>)[k]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
}

/** JSON with sorted keys, 2-space indent and a trailing newline. */
export function stableJson(v: unknown): string {
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`;
}
