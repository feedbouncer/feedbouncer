import { expect, it } from 'vitest';
import { competitorConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileCompetitorRule } from './competitor.js';

const b = { now: () => 0, startedAt: 0, limitMs: 50 };
const v = (body: string) =>
  new CommentView({ body, platform: 'facebook', authorExternalId: null, authorName: null });
const m = compileCompetitorRule(
  competitorConditions.parse({
    type: 'competitor',
    names: ['Acme Corp'],
    handles: ['@acme'],
    domains: ['acme.com'],
  }),
);

it('matches names as whole words, handles as @mentions, domains as links', () => {
  expect(m(v('try ACME corp instead'), b)).toEqual({
    kind: 'competitor',
    term: 'Acme Corp',
    via: 'name',
  });
  expect(m(v('ask @Acme.'), b)).toEqual({ kind: 'competitor', term: 'acme', via: 'handle' });
  expect(m(v('shop.acme.com is cheaper'), b)).toEqual({
    kind: 'competitor',
    term: 'acme.com',
    via: 'domain',
  });
});
it('does not match lookalike suffix domains, partial handles or words', () => {
  expect(m(v('acme.com.evil.io @acmeish acmecorporation'), b)).toBeNull();
});
