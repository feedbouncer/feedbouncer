// Keeps the community-health files honest: they exist, links resolve (including
// from .github/, where only absolute repo URLs work), commands they name are real
// scripts, the license is consistent, and nothing placeholder- or secret-shaped
// ships. Later sections are appended per file; keep the helpers at the top.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_URL = 'https://github.com/feed-bouncer-hq/feed-bouncer';
const abs = (rel) => join(ROOT, rel);
const read = (rel) => readFileSync(abs(rel), 'utf8');

const COMMUNITY_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md',
];
const present = () => COMMUNITY_FILES.filter((f) => existsSync(abs(f)));

function workspaceManifests() {
  return ['apps', 'packages'].flatMap((dir) =>
    readdirSync(abs(dir))
      .filter((name) => statSync(abs(`${dir}/${name}`)).isDirectory())
      .map((name) => `${dir}/${name}/package.json`)
      .filter((f) => existsSync(abs(f))),
  );
}

const stripFences = (text) => text.replace(/```[\s\S]*?```/g, '');

/** GitHub-style heading slugs, with -1, -2 suffixes for duplicates. */
function anchorsOf(rel) {
  const counts = new Map();
  const out = new Set();
  for (const [, heading] of stripFences(read(rel)).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const REPO_FILE_URL = new RegExp(
  `${REPO_URL.replace(/[./]/g, '\\$&')}/(?:blob|tree)/main/[^\\s)>"'\`]+`,
  'g',
);

function linkTargets(rel) {
  const text = stripFences(read(rel));
  const out = [];
  for (const [, href] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(href);
  for (const [url] of text.matchAll(REPO_FILE_URL)) out.push(url);
  return out;
}

/** null = not a repo file (external site, mailto:, repo issues/advisories pages). */
function resolveLink(fromRel, href) {
  if (href.startsWith(`${REPO_URL}/`)) {
    const m = href.slice(REPO_URL.length).match(/^\/(?:blob|tree)\/main\/([^#?]+)(?:#(.+))?$/);
    return m ? { file: decodeURIComponent(m[1]), anchor: m[2] } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const [path, anchor] = href.split('#');
  const file =
    path === ''
      ? fromRel
      : relative(ROOT, resolve(dirname(abs(fromRel)), decodeURIComponent(path)));
  return { file, anchor };
}

const PLACEHOLDERS = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bFIXME\b/,
  /lorem ipsum/i,
  /[\w.+-]+@example\.(?:com|org|net)\b/i,
  /https?:\/\/(?:www\.)?example\.(?:com|org|net)\b/i,
  /\[INSERT[^\]]*\]/i,
  /<your[- ][a-z -]+>/i,
  /<D[1-6]_[A-Z_]+>/,
];
const PERSONAL_PATHS = [/\/Users\/[A-Za-z]/, /\/home\/[a-z][\w-]*\//, /[A-Z]:\\Users\\/];
const SECRET_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bEAA[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

test('community files contain no placeholders, personal paths or secret-shaped strings', () => {
  for (const rel of present()) {
    const text = read(rel);
    // LICENSE is canonical text; its "How to Apply" appendix legitimately has <year> etc.
    const patterns =
      rel === 'LICENSE' ? SECRET_SHAPES : [...PLACEHOLDERS, ...PERSONAL_PATHS, ...SECRET_SHAPES];
    for (const re of patterns) assert.ok(!re.test(text), `${rel} matches ${re}`);
  }
});

test('links in community files resolve inside the repo, including heading anchors', () => {
  for (const rel of present().filter((f) => f !== 'LICENSE')) {
    for (const href of linkTargets(rel)) {
      if (rel.startsWith('.github/'))
        assert.ok(
          /^[a-z][a-z0-9+.-]*:/i.test(href),
          `${rel}: relative link ${href} will not resolve from an issue/PR body; use ${REPO_URL}/blob/main/...`,
        );
      const target = resolveLink(rel, href);
      if (!target) continue;
      assert.ok(
        !target.file.startsWith('..') && !target.file.startsWith(sep),
        `${rel}: ${href} points outside the repo`,
      );
      assert.ok(existsSync(abs(target.file)), `${rel}: broken link ${href}`);
      if (target.anchor && target.file.endsWith('.md'))
        assert.ok(
          anchorsOf(target.file).has(target.anchor),
          `${rel}: ${href} has no heading #${target.anchor}`,
        );
    }
  }
});

// --- pnpm command drift ---
const PNPM_BUILTINS = new Set(['install', 'i', 'turbo', 'exec', 'dlx', 'licenses', 'why', 'add']);

/** Every `pnpm …` command in inline code or at the start of a fenced-code line. */
function pnpmCommandsIn(rel) {
  const text = read(rel);
  const raw = [
    ...[...text.matchAll(/`(pnpm [^`]+)`/g)].map((m) => m[1]),
    ...[...text.matchAll(/```[\s\S]*?```/g)].flatMap((m) =>
      [...m[0].matchAll(/^\s*(pnpm [^\n#]+)/gm)].map((l) => l[1]),
    ),
  ];
  return raw
    .flatMap((c) => c.split(/&&|\|\|/))
    .map((c) => c.trim())
    .filter((c) => c.startsWith('pnpm '));
}

function assertPnpmCommandsExist(rel) {
  const rootScripts = new Set(Object.keys(JSON.parse(read('package.json')).scripts));
  const pkgScripts = new Map(
    workspaceManifests().map((f) => {
      const p = JSON.parse(read(f));
      return [p.name, new Set(Object.keys(p.scripts ?? {}))];
    }),
  );
  const commands = pnpmCommandsIn(rel);
  assert.ok(commands.length > 0, `${rel} should show its commands`);
  for (const cmd of commands) {
    const t = cmd.split(/\s+/);
    if (t[1] === '--filter') {
      const pkg = t[2].replace(/\.\.\.$/, '');
      assert.ok(pkgScripts.has(pkg), `${rel}: \`${cmd}\` names unknown package ${pkg}`);
      const script = t[3] === 'run' ? t[4] : t[3];
      if (!PNPM_BUILTINS.has(script))
        assert.ok(
          pkgScripts.get(pkg).has(script),
          `${rel}: \`${cmd}\`: ${pkg} has no script ${script}`,
        );
      continue;
    }
    const script = t[1] === 'run' ? t[2] : t[1];
    if (PNPM_BUILTINS.has(script) || script.startsWith('-')) continue;
    assert.ok(rootScripts.has(script), `${rel}: \`${cmd}\`: no root script ${script}`);
  }
}

// The existing README already names many commands, so this guard is useful from day one.
test('pnpm commands named in README exist', () => assertPnpmCommandsExist('README.md'));
