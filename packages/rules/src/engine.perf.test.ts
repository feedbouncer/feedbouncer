import { expect, it } from 'vitest';
import { compileRuleSet, evaluate } from './engine.js';

// 330 evaluate() calls plus a naive-scan comparison over 5000-term lists can clear
// vitest's 5s default under CI load; give it headroom rather than racing the clock.
it('evaluates a 2000-char comment against 5000-term lists within a bounded multiple of a naive scan', () => {
  const terms = Array.from({ length: 5000 }, (_, i) => `term${i} word${i % 97}`);
  const authors = Array.from({ length: 5000 }, (_, i) => ({
    externalId: String(10_000 + i),
    handle: `user_${i}`,
  }));
  const conditions = [
    { type: 'keyword', terms, match: 'whole_word' },
    { type: 'keyword', terms: terms.slice(0, 2000), match: 'contains' },
    { type: 'author', list: 'block', platform: 'facebook', entries: authors },
    { type: 'competitor', names: terms.slice(0, 500), handles: ['acme'], domains: ['acme.com'] },
    {
      type: 'link_domain',
      mode: 'blocklist',
      domains: Array.from({ length: 1000 }, (_, i) => `d${i}.com`),
    },
    { type: 'emoji', emoji: ['🤑', '💰'], maxCount: 30 },
    { type: 'regex', patterns: ['whats?app\\s*\\+?\\d{6,}', 'telegram\\.me/\\w+'] },
  ];
  const rules = conditions.map((c, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `r${i}`,
    action: 'hide' as const,
    actions: [{ type: 'hide' as const }],
    mode: 'enforce' as const,
    priority: i,
    enabled: true,
    createdAt: new Date(0),
    conditions: c,
  }));

  const set = compileRuleSet(rules, { ownDomains: ['example.com'] }, 'perf');
  expect(set.invalid).toEqual([]);
  expect(set.rules).toHaveLength(rules.length);

  const body = 'Lorem ipsum dolor sit amet, visit https://shop.example.com/x and say hi 😀 '
    .repeat(40)
    .slice(0, 2000);
  const facts = {
    body,
    platform: 'facebook' as const,
    authorExternalId: '1',
    authorName: 'nobody',
  };
  expect(evaluate(set, facts).decided).toBeNull();
  for (let i = 0; i < 30; i++) evaluate(set, facts); // warm-up
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    evaluate(set, facts);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)]!;

  // A naive scan of the same terms measured on this machine under the same load.
  const naive: number[] = [];
  let sink = 0;
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    let hits = 0;
    for (const term of terms) if (body.includes(term)) hits++;
    sink += hits;
    naive.push(performance.now() - t);
  }
  naive.sort((a, b) => a - b);
  expect(sink).toBe(0);
  expect(p95).toBeLessThan(naive[Math.floor(naive.length / 2)]! * 500);
}, 20000);
