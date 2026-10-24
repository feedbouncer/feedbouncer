import type { RuleConditions } from './conditions.js';
import { compileRuleSet, evaluate } from './engine.js';
import { compilePattern } from './regex.js';
import type { CommentFacts, RuleRecord } from './types.js';

export const PROBE_TEXTS = [
  'ok',
  'Thanks!',
  'Where can I buy this?',
  'Love it 😍',
  'Hola, ¿cuánto cuesta?',
  'Does it ship to Canada',
  '12345',
  'https://example.org/page',
] as const;

const probe = (body: string): CommentFacts => ({
  body,
  platform: 'instagram',
  authorExternalId: null,
  authorName: '',
  origin: 'organic',
});

/** 'matches_everything' when the conditions would catch every ordinary comment, else null. */
export function checkOverbroad(conditions: RuleConditions): string | null {
  if (conditions.type === 'regex' && conditions.patterns.some((p) => compilePattern(p).test('')))
    return 'matches_everything';
  const record: RuleRecord = {
    id: 'probe',
    name: 'probe',
    conditions,
    action: 'flag',
    actions: [],
    mode: 'enforce',
    priority: 0,
    enabled: true,
    appliesTo: 'all',
    createdAt: new Date(0),
  };
  const set = compileRuleSet([record], { ownDomains: [] }, 'probe');
  return PROBE_TEXTS.every((text) => evaluate(set, probe(text)).decided !== null)
    ? 'matches_everything'
    : null;
}
