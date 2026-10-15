import { expect, it } from 'vitest';
import { compileRuleSet, evaluate } from './engine.js';

it('evaluates a 2000-char comment against 5000-term lists in < 25 ms p95', () => {
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
    mode: 'enforce' as const,
    priority: i,
    enabled: true,
    createdAt: new Date(0),
    conditions: c,
  }));

  const c0 = performance.now();
  const set = compileRuleSet(rules, { ownDomains: ['example.com'] }, 'perf');
  const compileMs = performance.now() - c0;
  expect(set.invalid).toEqual([]);
  expect(set.rules).toHaveLength(rules.length);
  expect(compileMs).toBeLessThan(500);

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
  expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(25);
});
