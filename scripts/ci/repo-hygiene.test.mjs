// Keeps the community-health files honest: they all exist, their links resolve
// (including from .github/, where only absolute repo URLs work), commands they name
// are real scripts, issue forms follow GitHub's rules, and nothing placeholder- or
// secret-shaped ships.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { SECRET_PATTERNS } from './lib/secret-patterns.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_URL = 'https://github.com/feedbouncer/feedbouncer';
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

test('every community-health file exists', () => {
  for (const f of COMMUNITY_FILES) assert.ok(existsSync(abs(f)), `missing ${f}`);
});

// --- License ---
const LICENSE_MARKERS = {
  'AGPL-3.0-only': [
    'GNU AFFERO GENERAL PUBLIC LICENSE',
    'Version 3, 19 November 2007',
    'END OF TERMS AND CONDITIONS',
  ],
};
// sha256 of the canonical file as downloaded from the license steward (gnu.org). To
// change LICENSE, re-download it; never hand-edit.
const LICENSE_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';
// The AGPL text has no holder slot, so the notice lives in the README.
const COPYRIGHT_LINE = 'Copyright (C) 2026 FeedBouncer';

test('LICENSE is the unmodified canonical text of the declared license', () => {
  const declared = JSON.parse(read('package.json')).license;
  assert.ok(LICENSE_MARKERS[declared], `unexpected root license ${declared}`);
  const text = read('LICENSE');
  for (const m of LICENSE_MARKERS[declared]) assert.ok(text.includes(m), `LICENSE lacks "${m}"`);
  assert.equal(
    createHash('sha256')
      .update(readFileSync(abs('LICENSE')))
      .digest('hex'),
    LICENSE_SHA256,
  );
});

test('every workspace manifest declares the root license', () => {
  const declared = JSON.parse(read('package.json')).license;
  for (const f of workspaceManifests())
    assert.equal(JSON.parse(read(f)).license, declared, `${f} license field`);
});

// --- Code of conduct ---
const CONDUCT_EMAIL = 'conduct@feedbouncer.com';

test('CODE_OF_CONDUCT.md is the Contributor Covenant with a real contact', () => {
  const text = read('CODE_OF_CONDUCT.md');
  assert.match(text, /Contributor Covenant/);
  assert.match(text, /contributor-covenant\.org\/version\/\d/);
  assert.ok(text.includes(CONDUCT_EMAIL), 'enforcement contact missing');
  assert.ok(!/\[NOTE:/i.test(text), 'unfilled template note left in the code of conduct');
});

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
];
const PERSONAL_PATHS = [/\/Users\/[A-Za-z]/, /\/home\/[a-z][\w-]*\//, /[A-Z]:\\Users\\/];

test('community files contain no placeholders, personal paths or secret-shaped strings', () => {
  for (const rel of present()) {
    const text = read(rel);
    // LICENSE is canonical text; its "How to Apply" appendix legitimately has <year> etc.
    const patterns =
      rel === 'LICENSE' ? SECRET_PATTERNS : [...PLACEHOLDERS, ...PERSONAL_PATHS, ...SECRET_PATTERNS];
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

const PVR_URL = `${REPO_URL}/security/advisories/new`;

// --- Issue forms and PR template ---
const FORM_TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);

function assertValidForm(rel) {
  const form = parse(read(rel));
  for (const k of ['name', 'description']) assert.equal(typeof form[k], 'string', `${rel}: ${k}`);
  assert.ok(Array.isArray(form.body) && form.body.length > 0, `${rel}: body`);
  const ids = new Set();
  let fields = 0;
  for (const el of form.body) {
    assert.ok(FORM_TYPES.has(el.type), `${rel}: unknown type ${el.type}`);
    if (el.type === 'markdown') {
      assert.equal(typeof el.attributes?.value, 'string', `${rel}: markdown value`);
      continue;
    }
    fields += 1;
    assert.equal(typeof el.attributes?.label, 'string', `${rel}: label`);
    if (el.id !== undefined) {
      assert.match(el.id, /^[a-z0-9_-]+$/, `${rel}: id ${el.id}`);
      assert.ok(!ids.has(el.id), `${rel}: duplicate id ${el.id}`);
      ids.add(el.id);
    }
    if (el.type === 'dropdown' || el.type === 'checkboxes')
      assert.ok(el.attributes.options?.length > 0, `${rel}: options`);
  }
  assert.ok(fields > 0, `${rel}: needs at least one non-markdown field`);
  return { form, ids };
}

const requiredIds = (form) =>
  new Set(form.body.filter((e) => e.validations?.required).map((e) => e.id));

test('bug report form collects version, steps, expected/actual and logs safely', () => {
  const rel = '.github/ISSUE_TEMPLATE/bug_report.yml';
  const { form, ids } = assertValidForm(rel);
  for (const id of ['version', 'steps', 'expected', 'actual', 'logs'])
    assert.ok(ids.has(id), `missing ${id}`);
  const req = requiredIds(form);
  for (const id of ['version', 'steps', 'expected', 'actual'])
    assert.ok(req.has(id), `${id} must be required`);
  const logs = form.body.find((e) => e.id === 'logs');
  assert.match(logs.attributes.description, /token|secret/i, 'logs field must warn about secrets');
  const redact = form.body.find((e) => e.id === 'redaction');
  assert.ok(
    redact?.attributes.options.every((o) => o.required),
    'redaction checkboxes must be required',
  );
  assert.ok(read(rel).includes(PVR_URL), 'bug form must point security reports to PVR');
});

test('feature request form asks for the problem and proposed behavior', () => {
  const { form } = assertValidForm('.github/ISSUE_TEMPLATE/feature_request.yml');
  const req = requiredIds(form);
  for (const id of ['problem', 'proposal']) assert.ok(req.has(id), `${id} must be required`);
});

test('chooser disables blank issues and routes security reports privately', () => {
  const cfg = parse(read('.github/ISSUE_TEMPLATE/config.yml'));
  assert.deepEqual(Object.keys(cfg).sort(), ['blank_issues_enabled', 'contact_links']);
  assert.equal(cfg.blank_issues_enabled, false);
  for (const l of cfg.contact_links) {
    for (const k of ['name', 'url', 'about'])
      assert.equal(typeof l[k], 'string', `contact link ${k}`);
    assert.match(l.url, /^https:\/\//);
  }
  assert.ok(
    cfg.contact_links.some((l) => l.url === PVR_URL),
    'a contact link must be the PVR form',
  );
});

test('PR template has summary, linked issue and a tests/docs checklist', () => {
  const text = `\n${read('.github/pull_request_template.md')}`;
  for (const h of ['## Summary', '## Linked issue', '## Checklist'])
    assert.ok(text.includes(`\n${h}\n`), `missing ${h}`);
  const boxes = [...text.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]);
  assert.ok(
    boxes.some((b) => /test/i.test(b)),
    'checklist needs a tests item',
  );
  assert.ok(
    boxes.some((b) => /doc/i.test(b)),
    'checklist needs a docs item',
  );
});

function assertSectionsInOrder(rel, headings) {
  const text = read(rel);
  let at = -1;
  for (const heading of headings) {
    const i = text.indexOf(`\n${heading}\n`);
    assert.ok(i > at, `${rel}: missing or out-of-order section ${heading}`);
    at = i;
  }
}

test('SECURITY tells reporters to use private reporting, not public issues', () => {
  const text = read('SECURITY.md');
  assert.ok(text.includes(PVR_URL), 'SECURITY.md must link private vulnerability reporting');
  assert.match(text, /not .*public issue/i);
  assertSectionsInOrder('SECURITY.md', ['## Reporting a vulnerability', '## Supported versions']);
});

test('CONTRIBUTING covers setup, conventions, checks, proposals and review, in order', () => {
  assertSectionsInOrder('CONTRIBUTING.md', [
    '## Development environment',
    '### Services for integration tests',
    '## Branches and commits',
    '## Before you ask for review',
    '## Proposing larger changes',
    '## What reviewers look for',
    '## Security issues',
  ]);
});

test('pnpm commands named in CONTRIBUTING exist', () => assertPnpmCommandsExist('CONTRIBUTING.md'));

test('README introduces the project, keeps operational sections and links community files', () => {
  const text = read('README.md');
  assert.match(text, /^# FeedBouncer\n\n[^#\n][^\n]*comment/i, 'first paragraph says what it does');
  assertSectionsInOrder('README.md', [
    '## Project status',
    '## Quick start',
    '## Running the tests',
    '## Repository layout',
    '## Local stack with Docker Compose',
    '## Development',
    '## Continuous integration',
    '## Contributing',
    '## Security',
    '## License',
  ]);
  for (const target of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md'])
    assert.ok(text.includes(`](${target})`), `README must link ${target}`);
  assert.ok(text.includes('](LICENSE)'), 'README must link LICENSE');
  assert.ok(text.includes(COPYRIGHT_LINE), 'README must carry the copyright notice');
  assert.match(text, /not affiliated with or endorsed by/i, 'platform non-endorsement statement');
});

test('README repository layout lists every app and package', () => {
  const layout = read('README.md').split('\n## Repository layout\n')[1].split('\n## ')[0];
  for (const dir of ['apps', 'packages'])
    for (const name of readdirSync(abs(dir)))
      if (statSync(abs(`${dir}/${name}`)).isDirectory())
        assert.ok(layout.includes(`\`${dir}/${name}\``), `layout is missing ${dir}/${name}`);
});

// --- Integrations (separately licensed client packages) ---
const N8N_PACKAGE = 'integrations/n8n-nodes-feedbouncer';

function integrationDirs() {
  assert.ok(existsSync(abs('integrations')), 'integrations/ directory is missing');
  return readdirSync(abs('integrations')).filter((name) =>
    existsSync(abs(`integrations/${name}/package.json`)),
  );
}

test('every integrations/* manifest is MIT with an MIT LICENSE and the copyright line', () => {
  const dirs = integrationDirs();
  assert.ok(dirs.length > 0, 'no integrations found');
  for (const name of dirs) {
    const dir = `integrations/${name}`;
    assert.equal(JSON.parse(read(`${dir}/package.json`)).license, 'MIT', `${dir} license field`);
    const license = read(`${dir}/LICENSE`);
    assert.ok(license.includes('MIT License'), `${dir}/LICENSE must be the MIT License`);
    assert.ok(license.includes('Copyright (c) 2026 FeedBouncer'), `${dir}/LICENSE copyright line`);
  }
});

test('n8n package has no runtime dependencies and the community keyword', () => {
  const p = JSON.parse(read(`${N8N_PACKAGE}/package.json`));
  assert.equal(Object.keys(p.dependencies ?? {}).length, 0, 'runtime dependencies');
  assert.ok(p.keywords.includes('n8n-community-node-package'), 'community keyword');
  assert.equal(p.peerDependencies['n8n-workflow'], '*');
  assert.deepEqual(p.files, ['dist']);
});

test('n8n build does not emit a tsbuildinfo into the published dist', () => {
  const { compilerOptions } = JSON.parse(read(`${N8N_PACKAGE}/tsconfig.json`));
  assert.notEqual(compilerOptions.incremental, true, 'incremental builds write dist/tsconfig.tsbuildinfo');
});

test('README states the n8n version CI tests against', () => {
  const versionFile = `${N8N_PACKAGE}/scripts/n8n-tested-version`;
  const version = read(versionFile).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, versionFile);
  for (const workflow of ['ci.yml', 'release-n8n-node.yml']) {
    assert.ok(read(`.github/workflows/${workflow}`).includes(versionFile), `${workflow} must read ${versionFile}`);
  }
  assert.ok(read(`${N8N_PACKAGE}/README.md`).includes(version), 'README must state the version');
});
