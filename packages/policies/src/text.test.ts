import { describe, expect, it } from 'vitest';
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
