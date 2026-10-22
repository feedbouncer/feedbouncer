import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { ALLOWED_LINK_HOSTS } from '../site.config';
import { loadExamples } from './lib/examples';
import {
  appRoot,
  body,
  codeBlocks,
  docFiles,
  FEEDBOUNCER_KEY_RE,
  findSecretLike,
  frontMatter,
  headings,
  links,
  repoRoot,
} from './lib/content';

const STATUSES = ['stable', 'partial', 'planned'];
const PLACEHOLDER_HOST = 'feedbouncer.example.com';
/** Only `00000000-0000-4000-8000-0000000000NN` may appear in the docs. */
const PLACEHOLDER_UUID_RE = /^00000000-0000-4000-8000-0000000000\d\d$/;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\./;
const LONG_NUMBER_RE = /\b\d{10,}\b/g;
/** The allowed placeholder UUID, unanchored, so its zero run is not mistaken for a long number. */
const PLACEHOLDER_UUID_IN_TEXT_RE = /\b00000000-0000-4000-8000-0000000000\d\d\b/g;
const longNumbers = (text: string): string[] =>
  text.replace(PLACEHOLDER_UUID_IN_TEXT_RE, '').match(LONG_NUMBER_RE) ?? [];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const REPO_LINK_RE = /<RepoLink\b[^>]*\bpath=["']([^"']+)["']/g;
const IMG_RE = /!\[([^\]]*)\]\([^)]*\)|<img\b[^>]*>/g;

/** Reasons a page's text should not be published. */
function leaks(text: string): string[] {
  return [
    ...findSecretLike(text),
    ...(FEEDBOUNCER_KEY_RE.exec(text) ?? []),
    ...(JWT_RE.exec(text) ?? []),
    ...longNumbers(text),
    ...(text.match(UUID_RE) ?? []).filter((u) => !PLACEHOLDER_UUID_RE.test(u)),
    ...[...text.matchAll(EMAIL_RE)].filter((m) => m[1] !== 'example.com').map((m) => m[0]),
  ];
}

/** Hosts in fenced code that are neither the placeholder nor an env variable. */
function badFenceHosts(md: string): string[] {
  return codeBlocks(md)
    .flatMap((b) => [...b.body.matchAll(/https?:\/\/([^\s/:"'`)]+)/g)].map((m) => m[1]!))
    .filter((h) => h !== PLACEHOLDER_HOST);
}

const pages = docFiles().map((file) => ({ file, name: relative(appRoot, file) }));
const rel = (file: string) => relative(appRoot, file);

describe('detectors', () => {
  const bad = readFileSync(join(appRoot, 'test/fixtures/leaked-key.md'), 'utf8');

  it('flag a leaked key and a local host in a fixture', () => {
    expect(leaks(bad)).toHaveLength(1);
    expect(badFenceHosts('```bash\n' + bad + '\n```')).toEqual(['localhost']);
    expect(longNumbers('id 1234567890')).toEqual(['1234567890']);
    expect(longNumbers('id 00000000-0000-4000-8000-000000000012')).toEqual([]);
    expect(longNumbers('00000000-0000-4000-8000-000000000012 and 1234567890')).toEqual([
      '1234567890',
    ]);
    expect(longNumbers('00000000-0000-4000-8000-000000000012345')).not.toEqual([]);
    expect(headings('# a\n### b')).toEqual([
      { depth: 1, text: 'a' },
      { depth: 3, text: 'b' },
    ]);
  });
});

describe('content guards', () => {
  it('finds the hand-written pages', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  test('every page has title, description and a valid status', () => {
    for (const { file, name } of pages) {
      const fm = frontMatter(file);
      expect(fm.title, `${name}: title`).toBeTruthy();
      expect(fm.description, `${name}: description`).toBeTruthy();
      expect(STATUSES, `${name}: status`).toContain(fm.status);
    }
  });

  test('no secrets, keys or realistic identifiers', () => {
    for (const { file, name } of pages) expect(leaks(readFileSync(file, 'utf8')), name).toEqual([]);
  });

  test('code blocks use only $FEEDBOUNCER_URL or the placeholder host', () => {
    for (const { file, name } of pages) expect(badFenceHosts(body(file)), name).toEqual([]);
  });

  test('external links are https on allowed hosts; product-repo links use RepoLink', () => {
    const allowed: readonly string[] = ALLOWED_LINK_HOSTS;
    for (const { file, name } of pages) {
      for (const link of links(body(file)).filter((l) => /^[a-z][a-z0-9+.-]*:/i.test(l))) {
        const url = new URL(link);
        if (url.protocol === 'mailto:') continue;
        expect(url.protocol, `${name}: ${link}`).toBe('https:');
        expect(allowed, `${name}: ${link}`).toContain(url.hostname);
        expect(link, `${name}: use <RepoLink> for product-repo links`).not.toMatch(
          /github\.com\/feedbouncer\/feedbouncer\//,
        );
      }
    }
  });

  test('RepoLink paths exist in the repo', () => {
    for (const { file, name } of pages) {
      for (const m of readFileSync(file, 'utf8').matchAll(REPO_LINK_RE))
        expect(existsSync(join(repoRoot, m[1]!)), `${name}: ${m[1]}`).toBe(true);
    }
  });

  test('headings: no H1 in body, no skipped levels', () => {
    for (const { file, name } of pages) {
      let previous = 1;
      for (const h of headings(body(file))) {
        expect(h.depth, `${name}: "${h.text}" is an H1`).toBeGreaterThan(1);
        expect(h.depth, `${name}: "${h.text}" skips a level`).toBeLessThanOrEqual(previous + 1);
        previous = h.depth;
      }
    }
  });

  test('images have alt text of at least 10 characters', () => {
    for (const { file, name } of pages) {
      for (const m of body(file).matchAll(IMG_RE)) {
        const alt = m[1] ?? /\balt=["']([^"']*)["']/.exec(m[0])?.[1] ?? '';
        expect(alt.trim().length, `${name}: ${m[0]}`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  test('no dangerouslySetInnerHTML in apps/docs/src', () => {
    const sources = readdirSync(join(appRoot, 'src'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    for (const f of sources)
      expect(readFileSync(f, 'utf8'), rel(f)).not.toContain('dangerouslySetInnerHTML');
  });

  test('comment text appears only inside ExampleComment', () => {
    const texts = loadExamples().map((e) => e.comment.text);
    expect(texts.length).toBeGreaterThan(0);
    for (const { file, name } of pages)
      for (const t of texts) expect(readFileSync(file, 'utf8'), name).not.toContain(t);
  });

  test('four top-level sidebar sections in order', async () => {
    const { default: sidebars } = await import('../sidebars');
    const labels = (sidebars.docs as { label: string }[]).map((s) => s.label);
    expect(labels).toEqual(['Concepts', 'Rules', 'API reference', 'MCP setup']);
  });
});

describe('concepts', () => {
  const conceptsDir = join(appRoot, 'docs/concepts');
  const REQUIRED_TERMS = [
    'organization',
    'brand',
    'connection',
    'platform',
    'api-key',
    'scope',
    'idempotency-key',
    'comment',
    'author',
    'decision',
    'action-step',
    'action-run',
    'outcome',
    'undo',
    'hidden-today',
    'rule',
    'condition',
    'enforce-mode',
    'dry-run',
    'review-mode',
    'suggestion',
    'classifier',
    'category',
    'threshold',
    'policy',
    'flagged-item',
    'rule-change-proposal',
    'webhook-endpoint',
    'delivery',
    'mcp',
    'mcp-tool',
  ];
  /** Docusaurus (github-slugger) output for the plain-text headings used in the glossary. */
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/ /g, '-');
  const glossarySlugs = () =>
    headings(body(join(conceptsDir, 'glossary.md')))
      .filter((h) => h.depth === 3)
      .map((h) => slug(h.text));

  it('glossary defines every REQUIRED_TERM', () => {
    const slugs = glossarySlugs();
    for (const term of REQUIRED_TERMS) expect(slugs, term).toContain(term);
  });

  it('every <Term id> used in any doc exists in the glossary', () => {
    const slugs = glossarySlugs();
    for (const { file, name } of pages) {
      for (const m of readFileSync(file, 'utf8').matchAll(/<Term\b[^>]*\bid=["']([^"']+)["']/g))
        expect(slugs, `${name}: ${m[1]}`).toContain(m[1]);
    }
  });

  it('comment-lifecycle has an ordered step list of at least 6 items covering arrive, store, rules, AI, action, record', () => {
    const items = [
      ...body(join(conceptsDir, 'comment-lifecycle.md')).matchAll(/^\d+\.\s+(.+)$/gm),
    ].map((m) => m[1]!.toLowerCase());
    expect(items.length).toBeGreaterThanOrEqual(6);
    const text = items.join('\n');
    for (const word of ['webhook', 'poll', 'rule', 'classifier', 'polic', 'action', 'decision'])
      expect(text, word).toContain(word);
  });
});
