export * from './types.js';
export {
  MAX_EVAL_CHARS,
  hasUnspacedScript,
  linkText,
  normalizeText,
  stripInvisible,
  truncateForEvaluation,
  words,
} from './normalize.js';
export { CommentView } from './view.js';
export type { Budget, Matcher } from './matchers/types.js';
export { compileKeywords, compileKeywordRule, type KeywordMatcher } from './matchers/keywords.js';
export { compileRegexRule } from './matchers/regex.js';
export { compileLinkRule } from './matchers/links.js';
export { compileEmojiRule } from './matchers/emoji.js';
export { compileAuthorRule } from './matchers/author.js';
export { compileCompetitorRule } from './matchers/competitor.js';
export { emojiGraphemes, emojiKey, isSingleEmoji } from './emoji.js';
export {
  CONDITION_LIMITS,
  checkActionForConditions,
  ruleConditionsSchema,
  ruleInputSchema,
  rulePatchSchema,
  type RuleConditions,
  type RuleInput,
  type RulePatch,
} from './conditions.js';
export { normalizeDomainEntry } from './domains.js';
export {
  RULE_BUDGET_MS,
  compileRuleSet,
  evaluate,
  type CompiledRule,
  type CompiledRuleSet,
} from './engine.js';
export { describeDecision, describeFallback } from './reason.js';
export { analyzeRules, type AnalyzableRule, type RuleWarnings } from './shadowing.js';
export {
  DomainLimitError,
  InvalidRuleActionError,
  InvalidRuleConditionsError,
  MAX_DOMAINS_PER_BRAND,
  MAX_RULES_PER_BRAND,
  PgRuleStore,
  RuleLimitError,
  type BrandDomain,
  type BrandScope,
  type StoredRule,
} from './store.js';
export { RuleSetCache } from './cache.js';
export {
  PgEvaluationStore,
  safeFallbackCode,
  type EvaluationRecord,
  type EvaluationRow,
  type EvaluationStatus,
} from './evaluations.js';
export { RULE_EVALUATE_JOB, RuleEvaluatePayload, bodySha256 } from './jobs/specs.js';
export { ruleEvaluateJob } from './jobs/evaluate.js';
export { RuleActionFallback } from './fallback.js';
export { RuleTrigger } from './trigger.js';
