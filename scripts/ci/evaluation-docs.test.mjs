// Keeps the evaluation method document honest and guards published reports:
// headings, runnable commands, documented constants and the settling rule must match the
// code, and no file under docs/evaluation/results/ may contain identifiable data.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC = join(ROOT, 'docs/evaluation/hide-metrics.md');
const RESULTS = join(ROOT, 'docs/evaluation/results');
const read = (p) => readFileSync(p, 'utf8');

const DOC_HEADINGS = [
  'What is measured',
  'Running an evaluation',
  'Labelling guide',
  "Comparing with Meta's built-in moderation",
  'Cost assumptions',
  'Privacy',
  'Reading the report',
  'Known limits',
];

const REPORT_HEADINGS = [
  '## Summary',
  '## Dataset and labelling',
  '## False-hide rate',
  '## Time to hide',
  '## Comments missed',
  "## Comparison with Meta's built-in moderation",
  '## Cost per 1,000 comments',
  '## Method and limits',
];

const FORBIDDEN = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\bi_[0-9a-f]{16}\b/,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /facebook\.com\/|instagram\.com\//,
];

/** Returns the problems found in a published report. */
function scanReport(text) {
  const problems = [];
  for (const h of REPORT_HEADINGS) {
    if (!text.split('\n').includes(h)) problems.push(`missing heading ${h}`);
  }
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`matches ${re}`);
  return problems;
}

const constant = (name) => {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(
    read(join(ROOT, 'packages/evaluation/src/constants.ts')),
  );
  assert.ok(m, `${name} not found in constants.ts`);
  return m[1];
};

test('the method document has its sections in order', () => {
  assert.ok(existsSync(DOC), 'docs/evaluation/hide-metrics.md is missing');
  const found = [...read(DOC).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(found, DOC_HEADINGS);
});

test('every `pnpm X` command resolves to a root script', () => {
  const scripts = JSON.parse(read(join(ROOT, 'package.json'))).scripts;
  const cmds = [...read(DOC).matchAll(/`pnpm ([a-z][\w:-]*)/g)].map((m) => m[1]);
  assert.ok(cmds.length > 0);
  for (const c of cmds) assert.ok(scripts[c], `no root script "${c}"`);
});

test('documented thresholds equal the constants', () => {
  const doc = read(DOC);
  for (const name of ['LOW_CONFIDENCE_N', 'LANGUAGE_MIN_N', 'MIN_LABELS_PER_ITEM']) {
    const m = new RegExp(`\`${name}\` = (\\d+)`).exec(doc);
    assert.ok(m, `${name} is not documented as \`${name}\` = <number>`);
    assert.equal(m[1], constant(name), name);
  }
});

test('the settling rule is copied verbatim', () => {
  const src = read(join(ROOT, 'packages/evaluation/src/ground-truth.ts'));
  const m = /SETTLING_RULE_TEXT =\s*'([^']+)'/.exec(src);
  assert.ok(m);
  assert.ok(read(DOC).includes(m[1]), 'settling rule text differs from SETTLING_RULE_TEXT');
});

test('the label categories are all documented', () => {
  const src = read(join(ROOT, 'packages/evaluation/src/constants.ts'));
  const list = /LABEL_CATEGORIES = \[([^\]]+)\]/.exec(src)[1];
  const doc = read(DOC);
  for (const [, c] of list.matchAll(/'([a-z_]+)'/g)) assert.ok(doc.includes(`\`${c}\``), c);
});

test('published reports are aggregate-only and complete', () => {
  assert.ok(existsSync(RESULTS), 'docs/evaluation/results is missing');
  for (const f of readdirSync(RESULTS)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    assert.deepEqual(scanReport(read(join(RESULTS, f))), [], f);
  }
});

test('the scanner rejects identifiable data and missing headings', () => {
  const good = `${REPORT_HEADINGS.join('\n\n')}\n`;
  assert.deepEqual(scanReport(good), []);
  const uuid = `${good}\n123e4567-e89b-12d3-a456-426614174000\n`;
  assert.ok(scanReport(uuid).length > 0);
  assert.ok(scanReport(`${good}\ni_0123456789abcdef`).length > 0);
  assert.ok(scanReport(`${good}\nsomeone@example.com`).length > 0);
  assert.ok(scanReport(`${good}\nhttps://www.facebook.com/x`).length > 0);
  assert.ok(scanReport('# FeedBouncer evaluation report\n').length > 0);
});
