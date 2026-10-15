import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  normalizePolicyText,
  policyInputSchema,
  policyIssues,
  policyPatchSchema,
  policyWarnings,
  previewRequestSchema,
  runRequestSchema,
} from './text.js';

const input = (o: Record<string, unknown>) =>
  policyInputSchema.safeParse({
    name: 'No DM solicitations',
    text: 'Hide comments telling people to DM another account',
    action: 'hide',
    ...o,
  });

describe('policyInputSchema', () => {
  it('accepts a normal policy and normalises whitespace', () => {
    const r = input({ text: '  Hide comments   telling people\nto DM another account  ' });
    expect(r.success && r.data.text).toBe('Hide comments telling people\nto DM another account');
  });
  it.each([
    ['', 'Write the policy as a sentence'],
    ['   ', 'Write the policy as a sentence'],
    ['spam', 'at least 8 characters'],
    ['nospamplease', 'at least two words'],
  ])('rejects %j with a clear message', (text, message) => {
    const r = input({ text });
    expect(r.success).toBe(false);
    if (!r.success) expect(policyIssues(r.error)[0]!.message).toContain(message);
  });
  it('rejects text over 500 characters', () => {
    expect(input({ text: 'word '.repeat(101) }).success).toBe(false);
  });
  it('rejects control and bidi-override characters in name and text', () => {
    expect(input({ name: 'No‮name' }).success).toBe(false);
    expect(input({ text: 'hide comments \u0007 that beep' }).success).toBe(false);
    expect(input({ text: 'hide comments ⁦that isolate' }).success).toBe(false);
  });
  it('rejects approve and unknown actions', () => {
    expect(input({ action: 'approve' }).success).toBe(false);
    expect(input({ action: 'ban' }).success).toBe(false);
  });
  it('rejects empty and long names', () => {
    expect(input({ name: ' ' }).success).toBe(false);
    expect(input({ name: 'n'.repeat(81) }).success).toBe(false);
  });
  it('accepts non-English, emoji and mixed scripts', () => {
    expect(
      input({ text: 'Ocultar comentarios que piden escribir por DM 📩 a otra cuenta' }).success,
    ).toBe(true);
    expect(input({ text: 'إخفاء التعليقات التي تطلب مراسلة حساب آخر' }).success).toBe(true);
  });
  it('rejects unknown keys', () => {
    expect(input({ enabled: true }).success).toBe(false);
  });
});

describe('policyPatchSchema', () => {
  it('requires at least one field', () => {
    expect(policyPatchSchema.safeParse({}).success).toBe(false);
    expect(policyPatchSchema.safeParse({ enabled: true }).success).toBe(true);
  });
});

describe('preview and run requests', () => {
  it('preview days default 7, 1..14', () => {
    const base = { text: 'Hide comments asking people to DM another account', action: 'hide' };
    expect(previewRequestSchema.parse(base).days).toBe(7);
    expect(previewRequestSchema.safeParse({ ...base, days: 15 }).success).toBe(false);
    expect(previewRequestSchema.safeParse({ ...base, days: 0 }).success).toBe(false);
  });
  it('run days default 7, 1..7', () => {
    expect(runRequestSchema.parse({}).days).toBe(7);
    expect(runRequestSchema.safeParse({ days: 8 }).success).toBe(false);
  });
});

describe('policyWarnings', () => {
  it('warns on vague text such as "bad stuff"', () => {
    expect(policyWarnings(normalizePolicyText('bad stuff'))).toEqual(['few_words', 'vague_terms']);
    expect(policyWarnings('hide inappropriate or offensive things')).toContain('vague_terms');
  });
  it('does not warn on a concrete policy', () => {
    expect(policyWarnings('Hide comments telling people to DM another account')).toEqual([]);
    expect(
      policyWarnings('Flag comments that mention a competitor price or a discount code'),
    ).toEqual([]);
  });
});

describe('fix round 1', () => {
  it.each(['\u200B', '\u200C', '\u200D', '\u2060', '\u00AD', '\uFEFF'])(
    'rejects invisible %j in name',
    (c) => {
      expect(input({ name: `No${c}name` }).success).toBe(false);
    },
  );
  it('rejects zero-width spaces hidden in text', () => {
    expect(input({ text: 'a\u200B\u200B\u200B\u200B\u200Bb' }).success).toBe(false);
    expect(input({ name: '\u200B' }).success).toBe(false);
  });
  it('counts combining-mark words as one word', () => {
    expect(policyWarnings('हिन्दी')).toContain('few_words');
    expect(input({ text: 'हिन्दी भाषा' }).success).toBe(true);
    expect(input({ text: 'สวัสดีครับ' }).success).toBe(false);
  });
  it('rejects \v and \f, accepts and collapses \t', () => {
    expect(input({ text: 'hide comments\vthat spam' }).success).toBe(false);
    expect(input({ text: 'hide comments\fthat spam' }).success).toBe(false);
    const r = input({ text: 'hide\t\tcomments that spam' });
    expect(r.success && r.data.text).toBe('hide comments that spam');
  });
  it('enforces 8..500 code points after NFC', () => {
    expect(input({ text: 'ab cd ef' }).success).toBe(true);
    expect(input({ text: 'ab cd e' }).success).toBe(false);
    expect(input({ text: 'a '.repeat(249) + 'aa' }).success).toBe(true);
    expect(input({ text: 'a '.repeat(249) + 'aaa' }).success).toBe(false);
    const decomposed = 'e\u0301 '.repeat(249) + 'e\u0301e\u0301';
    expect(input({ text: decomposed }).success).toBe(true);
  });
  it('counts emoji as one character', () => {
    const e = '\u{1F600}a '.repeat(166) + '\u{1F600}a';
    expect([...e].length).toBe(500);
    expect(input({ text: e }).success).toBe(true);
    expect(input({ text: e + 'b' }).success).toBe(false);
    expect(input({ name: '\u{1F600}'.repeat(80) }).success).toBe(true);
    expect(input({ name: '\u{1F600}'.repeat(81) }).success).toBe(false);
  });
  it('patch rejects a bad name, preview requires uuid policyId', () => {
    expect(policyPatchSchema.safeParse({ name: '\u200B' }).success).toBe(false);
    const base = { text: 'Hide comments asking people to DM another account', action: 'hide' };
    expect(previewRequestSchema.safeParse({ ...base, policyId: 'nope' }).success).toBe(false);
    expect(
      previewRequestSchema.safeParse({ ...base, policyId: '123e4567-e89b-42d3-a456-426614174000' })
        .success,
    ).toBe(true);
  });
  it('policyIssues caps at 10', () => {
    const r = z.array(z.string().min(5)).safeParse(Array.from({ length: 15 }, () => 'x'));
    expect(!r.success && policyIssues(r.error).length).toBe(10);
  });
});
