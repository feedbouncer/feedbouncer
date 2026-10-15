import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as emoji from './emoji.js';
import * as links from './links.js';
import * as normalize from './normalize.js';
import { CommentView } from './view.js';

vi.mock('./emoji.js', async (orig) => {
  const a = await orig<typeof import('./emoji.js')>();
  return { ...a, emojiGraphemes: vi.fn(a.emojiGraphemes) };
});
vi.mock('./links.js', async (orig) => {
  const a = await orig<typeof import('./links.js')>();
  return { ...a, extractLinksDetailed: vi.fn(a.extractLinksDetailed) };
});
vi.mock('./normalize.js', async (orig) => {
  const a = await orig<typeof import('./normalize.js')>();
  return {
    ...a,
    normalizeText: vi.fn(a.normalizeText),
    words: vi.fn(a.words),
    truncateForEvaluation: vi.fn(a.truncateForEvaluation),
  };
});

const facts = (body: string) =>
  ({ body, platform: 'facebook', authorExternalId: null, authorName: null }) as const;

beforeEach(() => vi.clearAllMocks());

describe('CommentView', () => {
  it('computes normalized, words, links and emoji lazily and once', () => {
    const view = new CommentView(facts('Hi 👍 example.com'));
    expect(normalize.normalizeText).not.toHaveBeenCalled();
    expect(links.extractLinksDetailed).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      expect(view.normalized).toBe('hi 👍 example.com');
      expect(view.words).toContain('hi');
      expect(view.links.map((l) => l.host)).toContain('example.com');
      expect(view.emoji).toEqual(['👍']);
      expect(view.linksTruncated).toBe(false);
    }
    expect(normalize.normalizeText).toHaveBeenCalledTimes(1);
    expect(normalize.words).toHaveBeenCalledTimes(1);
    expect(links.extractLinksDetailed).toHaveBeenCalledTimes(1);
    expect(emoji.emojiGraphemes).toHaveBeenCalledTimes(1);
  });
  it('truncates the body with truncateForEvaluation', () => {
    const body = 'a'.repeat(normalize.MAX_EVAL_CHARS + 50);
    const view = new CommentView(facts(body));
    expect(normalize.truncateForEvaluation).toHaveBeenCalledWith(body);
    expect(view.raw).toHaveLength(normalize.MAX_EVAL_CHARS);
    expect(view.normalized).toHaveLength(normalize.MAX_EVAL_CHARS);
  });
  it('exposes mentions without trailing dots, once', () => {
    const view = new CommentView(facts('hi @Acme. and @a.b_c'));
    expect([...view.mentions].sort()).toEqual(['a.b_c', 'acme']);
    expect(view.mentions).toBe(view.mentions);
  });
});
