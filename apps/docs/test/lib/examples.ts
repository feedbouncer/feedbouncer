import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveOutcome } from '@feedbouncer/actions';
import { ruleInputSchema, type CommentFacts, type RuleRecord } from '@feedbouncer/rules';
import { workedExampleSchema, type WorkedExampleData } from '../../src/examples/schema';
import { appRoot } from './content';

export const EXAMPLES_DIR = join(appRoot, 'docs/rules/examples');

export const exampleFiles = (): string[] =>
  readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

export const loadExamples = (): WorkedExampleData[] =>
  exampleFiles().map((f) =>
    workedExampleSchema.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8'))),
  );

/** The rule as the rule API accepts it: priority is set by order, not sent. */
export function ruleInput(rule: WorkedExampleData['rules'][number]) {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => key !== 'priority'));
}

/** Rules get `id = name`, a creation time that follows array order, and the derived outcome. */
export function toRecords(ex: WorkedExampleData): RuleRecord[] {
  return ex.rules.map((raw, i) => {
    const rule = ruleInputSchema.parse(ruleInput(raw));
    return {
      id: rule.name,
      name: rule.name,
      conditions: rule.conditions,
      action: deriveOutcome(rule.actions),
      actions: rule.actions,
      mode: rule.mode,
      priority: raw.priority,
      enabled: true,
      appliesTo: rule.appliesTo,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    };
  });
}

export function toFacts(comment: WorkedExampleData['comment']): CommentFacts {
  return {
    body: comment.text,
    platform: 'facebook',
    authorExternalId: comment.authorExternalId ?? null,
    authorName: comment.authorHandle ?? null,
    origin: 'organic',
  };
}
