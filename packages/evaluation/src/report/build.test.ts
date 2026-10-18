import { describe, expect, it } from 'vitest';
import type { RunInputs } from '../io.js';
import { item } from '../measures/fixtures.test-helper.js';
import type { LabelRow, MetaConfig } from '../schema.js';
import { buildReport } from './build.js';
import { escapeMd, stableJson } from './escape.js';
import { renderMarkdown } from './render-md.js';

const manifest: RunInputs['manifest'] = {
  runSchemaVersion: 1,
  exportedAt: '2026-10-18T00:00:00Z',
  window: { from: '2026-10-01', to: '2026-10-15' },
  brandsScoped: true,
  itemCount: 0,
  labelSheetCount: 0,
  sample: null,
  excludedAuthorDeleted: 0,
  timingUnavailableBeforeRetention: 0,
  bytesPerComment: null,
  promptVersions: ['p1'],
  jobRetentionDays: 30,
};

const metaConfig: MetaConfig = {
  observedOn: '2026-10-10',
  page: 'test page',
  profanityFilter: 'off',
  blockedKeywords: [],
  method: 'plain',
  notCompared: [],
};

function inputs(over: Partial<RunInputs> = {}): RunInputs {
  return {
    manifest,
    items: [],
    labels: [],
    meta: null,
    metaConfig: null,
    pricing: null,
    inputDigests: [{ file: 'items.jsonl', sha256: 'ab'.repeat(32) }],
    ...over,
  };
}

function labelled(n: number): RunInputs {
  const items = Array.from({ length: n }, () =>
    item({
      timing: { totalMs: 2000, retried: false, breakdown: null },
    }),
  );
  const labels: LabelRow[] = items.flatMap((i, idx) => [
    { item: i.item, labeller: 'alice_x', verdict: idx % 2 ? 'should_hide' : 'should_stay' },
    { item: i.item, labeller: 'bob_y', verdict: idx % 2 ? 'should_hide' : 'should_stay' },
  ]);
  return inputs({ items, labels });
}

const section = (md: string, heading: string) => {
  const start = md.indexOf(heading);
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start, next === -1 ? undefined : next);
};

describe('report', () => {
  it('is deterministic', () => {
    const i = labelled(5);
    const a = buildReport(i);
    const b = buildReport(i);
    expect(stableJson(a)).toBe(stableJson(b));
    expect(renderMarkdown(a)).toBe(renderMarkdown(b));
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
    );
  });

  it('contains no item ids, labeller names or label-sheet text', () => {
    const i = labelled(4);
    const rows = i.labels.map((l) => ({ ...l, text: 'secret comment text' }));
    const r = buildReport({ ...i, labels: rows });
    const out = stableJson(r) + renderMarkdown(r);
    for (const it of i.items) expect(out).not.toContain(it.item);
    expect(out).not.toContain('alice_x');
    expect(out).not.toContain('bob_y');
    expect(out).not.toContain('secret comment text');
  });

  it('never renders not enough data as 0%', () => {
    const md = renderMarkdown(buildReport(inputs()));
    const s = section(md, '## False-hide rate');
    expect(s).toContain('not enough data (n=0)');
    expect(s).not.toContain('0.0%');
  });

  it('flags a small sample', () => {
    expect(renderMarkdown(buildReport(labelled(10)))).toContain('low confidence (n<30)');
  });

  it('escapes Markdown injection', () => {
    const md = renderMarkdown(
      buildReport(
        inputs({
          meta: [],
          metaConfig: { ...metaConfig, method: '[x](javascript:alert(1)) <img src=x>' },
        }),
      ),
    );
    expect(md).not.toContain('](');
    expect(md).not.toContain('<img');
    expect(escapeMd('a\nb_c')).toBe('a b\\_c');
  });

  it('has section headings in order', () => {
    const md = renderMarkdown(buildReport(inputs()));
    const heads = [
      '## Summary',
      '## Dataset and labelling',
      '## False-hide rate',
      '## Time to hide',
      '## Comments missed',
      "## Comparison with Meta's built-in moderation",
      '## Cost per 1,000 comments',
      '## Method and limits',
    ];
    const at = heads.map((h) => md.indexOf(h));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('renders the review cohort separately and states the human wait', () => {
    const md = renderMarkdown(buildReport(labelled(3)));
    const t = section(md, '## Time to hide');
    expect(t).toContain('Review mode (human approval required)');
    expect(t).toContain('includes the wait for a human');
    expect(section(md, '## Comments missed')).toContain('Review mode (human approval required)');
  });

  it('surfaces agreement, settling rule and conditional limits', () => {
    const i = labelled(3);
    const md = renderMarkdown(
      buildReport({
        ...i,
        manifest: { ...manifest, timingUnavailableBeforeRetention: 2 },
        meta: [],
        metaConfig,
      }),
    );
    expect(md).toContain('Agreement');
    expect(md).toContain('Settling rule: Each comment is labelled');
    expect(md).toContain(
      'job ledger rows older than 30 days are purged; 2 hidden items have no breakdown',
    );
    expect(md).toContain('Meta comparison covers 0 comments; see method');
    expect(md).toContain('posted_at has 1-second resolution');
  });
});
