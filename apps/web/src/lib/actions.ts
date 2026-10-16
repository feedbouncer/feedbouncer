// The logic behind the step editor, action log and review queue, kept free of React so it
// can be tested directly. The API decides what each connection supports; this module
// presents its answer.
import type { ActionStep, StepType } from '@feedbouncer/actions';
import { apiFetch } from './api-client';
import { outcomeSentence, outcomeText as reasonCopy } from './messages';
import { PLATFORM_COPY, isConnectable } from './platforms';

export type StepStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'not_applicable'
  | 'not_supported'
  | 'simulated';

export const STEP_STATUSES: readonly StepStatus[] = [
  'pending',
  'succeeded',
  'failed',
  'skipped',
  'not_applicable',
  'not_supported',
  'simulated',
];

/** Execution order: the order steps are listed and saved in. */
export const STEP_ORDER: readonly StepType[] = [
  'flag_for_review',
  'private_reply',
  'auto_reply',
  'hide',
  'ban',
  'delete',
];

export const STEP_LABEL: Record<StepType, string> = {
  hide: 'Hide',
  delete: 'Delete',
  ban: 'Ban author',
  auto_reply: 'Auto-reply',
  private_reply: 'Private reply',
  flag_for_review: 'Flag for review',
};

export const REVERSIBILITY_LABEL: Record<StepType, string> = {
  hide: 'Reversible',
  delete: 'Irreversible',
  ban: 'Hard to reverse (unban)',
  auto_reply: 'Partly reversible (reply can be deleted)',
  private_reply: 'Irreversible',
  flag_for_review: 'Reversible',
};

/** Label of the separate, initially unticked box that confirms a chosen destructive step. */
export const CONFIRM_LABEL: Partial<Record<StepType, string>> = {
  delete: 'I understand deleted comments cannot be restored',
  ban: 'I understand a ban is hard to reverse',
};

export const TEMPLATE_HELP: readonly { token: string; help: string }[] = [
  {
    token: '{{author_name}}',
    help: "The commenter's name (up to 50 characters; falls back to “there”)",
  },
  {
    token: '{{author_first_name}}',
    help: 'Their first name (up to 30 characters; falls back to “there”)',
  },
  { token: '{{brand_name}}', help: 'Your brand name (up to 100 characters)' },
  { token: '{{platform}}', help: 'Facebook or Instagram' },
];
export const TEMPLATE_SYNTAX_HELP =
  'Use {{name}} or {{name|fallback}}. The fallback is used when the value is missing.';

const VARIABLE_MAX: Record<string, number> = {
  author_name: 50,
  author_first_name: 30,
  brand_name: 100,
  platform: 20,
};
const TOKEN = /\{\{\s*([a-z_]{1,32})\s*(?:\|([^{}|\n]{0,50}))?\}\}/g;

const codePoints = (s: string): number => Array.from(s).length;

/** Longest the rendered reply can be, in code points: every variable at its maximum. */
export function worstCaseLength(template: string): number {
  const rendered = template.replace(TOKEN, (_m, name: string, inline: string | undefined) => {
    const max = VARIABLE_MAX[name] ?? 0;
    const fallback = inline === undefined ? 0 : codePoints(inline.trim());
    return 'x'.repeat(Math.max(max, fallback));
  });
  return codePoints(rendered);
}

export function templateCount(
  template: string,
  max: number | null,
): { count: number; max: number | null; over: boolean } {
  const count = worstCaseLength(template.trim());
  return { count, max, over: max !== null && count > max };
}

export interface ActionCapabilitiesDto {
  steps: Record<
    StepType,
    {
      platforms: {
        platform: string;
        connectionId: string;
        supported: boolean;
        missingScopes: string[];
        maxChars: number | null;
      }[];
    }
  >;
}

export const platformLabel = (p: string): string => (isConnectable(p) ? PLATFORM_COPY[p].label : p);

export interface StepAvailability {
  /** False when no platform in scope supports the step. */
  available: boolean;
  /** Platforms in scope where the step is missing, as labels. */
  unavailableOn: string[];
  /** The smallest reply length among the platforms that support it. */
  maxChars: number | null;
  /** Platforms in scope that support the step but did not grant a permission it needs. */
  missingPermissionOn: string[];
}

/** What each step can do on the platforms in scope: the author rule's, else all connected. */
export function stepAvailability(
  caps: ActionCapabilitiesDto,
  onlyPlatform?: string,
): Record<StepType, StepAvailability> {
  const result = {} as Record<StepType, StepAvailability>;
  for (const type of STEP_ORDER) {
    const entries = caps.steps[type].platforms.filter(
      (p) => onlyPlatform === undefined || p.platform === onlyPlatform,
    );
    const inScope = [...new Set(entries.map((e) => e.platform))];
    const supported = entries.filter((e) => e.supported);
    const supportedOn = new Set(supported.map((e) => e.platform));
    const limits = supported.flatMap((e) => (e.maxChars === null ? [] : [e.maxChars]));
    result[type] = {
      available: inScope.length === 0 || supportedOn.size > 0,
      unavailableOn: inScope.filter((p) => !supportedOn.has(p)).map(platformLabel),
      maxChars: limits.length > 0 ? Math.min(...limits) : null,
      missingPermissionOn: [
        ...new Set(supported.filter((e) => e.missingScopes.length > 0).map((e) => e.platform)),
      ].map(platformLabel),
    };
  }
  return result;
}

/**
 * A step as edited. Delete and Ban are chosen first and confirmed with their own box, so
 * until then they lack the confirmation the API requires.
 */
export type DraftStep = ActionStep | { type: 'delete' } | { type: 'ban' };

const newStep = (type: StepType): DraftStep => {
  switch (type) {
    case 'auto_reply':
    case 'private_reply':
      return { type, template: '' };
    // Delete and Ban start unconfirmed: their own box adds the confirmation.
    case 'delete':
      return { type: 'delete' };
    case 'ban':
      return { type: 'ban' };
    case 'hide':
    case 'flag_for_review':
      return { type };
  }
};

const byOrder = (a: DraftStep, b: DraftStep): number =>
  STEP_ORDER.indexOf(a.type) - STEP_ORDER.indexOf(b.type);

/** Adds or removes a step, keeping execution order. Delete and Ban are added unconfirmed. */
export function toggleStep(value: DraftStep[], type: StepType, on: boolean): DraftStep[] {
  const rest = value.filter((s) => s.type !== type);
  return on ? [...rest, newStep(type)].sort(byOrder) : rest;
}

export type DestructiveType = 'delete' | 'ban';

export const isConfirmed = (step: DraftStep): boolean =>
  step.type === 'delete'
    ? 'confirmIrreversible' in step
    : step.type === 'ban'
      ? 'confirmHardToReverse' in step
      : true;

/** Ticks or unticks the confirmation box of a chosen Delete or Ban step. */
export function setConfirmed(value: DraftStep[], type: DestructiveType, on: boolean): DraftStep[] {
  return value.map((s): DraftStep => {
    if (s.type !== type) return s;
    if (!on) return type === 'delete' ? { type: 'delete' } : { type: 'ban' };
    return type === 'delete'
      ? { type, confirmIrreversible: true }
      : { type, confirmHardToReverse: true };
  });
}

/** The steps to save, or null while a chosen Delete or Ban is not confirmed. */
export function readySteps(value: readonly DraftStep[]): ActionStep[] | null {
  return value.every(isConfirmed) ? (value as ActionStep[]) : null;
}

export function setTemplate(
  value: DraftStep[],
  type: 'auto_reply' | 'private_reply',
  template: string,
): DraftStep[] {
  return value.map((s) => (s.type === type ? { type, template } : s));
}

/** A problem with a saved rule's steps on one connected account (the rule was still saved). */
export interface StepWarningDto {
  type: StepType;
  code: string;
  platform: string;
  connectionId: string;
  scopes?: string[];
}

/** The warnings of a rule create or update response. */
export function savedWarnings(
  res: { actionWarnings?: StepWarningDto[] } | undefined,
): StepWarningDto[] {
  return Array.isArray(res?.actionWarnings) ? res.actionWarnings : [];
}

export function warningText(w: StepWarningDto): string {
  const step = STEP_LABEL[w.type];
  const platform = platformLabel(w.platform);
  if (w.code === 'missing_permission') {
    const perms = w.scopes && w.scopes.length > 0 ? w.scopes.join(', ') : 'a permission it needs';
    return `${step}: your ${platform} account has not allowed ${perms}. Reconnect it and allow the permission, or this step fails.`;
  }
  if (w.code === 'not_supported_on_platform')
    return `${step}: not available on ${platform}, so it does not run there.`;
  return `${step} on ${platform}: ${outcomeSentence(w.code)}`;
}

const CONFLICTS: readonly (readonly [StepType, StepType, string])[] = [
  ['auto_reply', 'hide', "Can't reply to a hidden comment."],
  ['auto_reply', 'delete', "Can't reply to a deleted comment."],
  ['private_reply', 'ban', "Can't message a banned author."],
  ['hide', 'delete', 'Delete already removes the comment.'],
];

/** Why a step cannot be added next to the ones already chosen, or null. */
export function conflictReason(type: StepType, value: readonly DraftStep[]): string | null {
  for (const [a, b, reason] of CONFLICTS) {
    const other = type === a ? b : type === b ? a : null;
    if (other !== null && value.some((s) => s.type === other)) {
      return `${reason} Remove ${STEP_LABEL[other]} first.`;
    }
  }
  return null;
}

const TEMPLATE_ISSUES: Record<string, string> = {
  empty: 'Write the reply text.',
  too_long: 'The reply is too long.',
  unknown_variable: 'The reply uses a variable that does not exist.',
  malformed_token: 'The reply has a variable that is not written correctly.',
  too_many_tokens: 'The reply uses too many variables.',
};

export function stepIssueText(code: string): string {
  return Object.hasOwn(TEMPLATE_ISSUES, code) ? TEMPLATE_ISSUES[code]! : outcomeSentence(code);
}

/** Server messages for the step at `index`, from issues whose path is actions.<index>[.…]. */
export function stepIssues(issues: readonly { path: string; message: string }[], index: number) {
  const prefix = `actions.${index}`;
  return issues
    .filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))
    .map((i) => stepIssueText(i.message));
}

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Waiting to run',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  not_applicable: 'Not applicable',
  not_supported: 'Not supported',
  simulated: 'Dry run',
};

export function outcomeText(status: StepStatus, reason: string | null): string {
  const label = STATUS_LABEL[status];
  return reason === null ? label : `${label}: ${reasonCopy(reason)}`;
}

export interface LogEntryView {
  id: string;
  commentId: string;
  ruleName: string;
  type: StepType;
  status: StepStatus;
  reasonCode: string | null;
  undoable: boolean;
  /** When the step was last undone; null if never, or if the latest undo was refused at once. */
  undoneAt: string | null;
  /** Status of the latest undo's platform action (null for a dismissed flag). */
  undoStatus: string | null;
  createdAt: string;
}

const UNDO_FAILED = new Set(['failed', 'not_eligible']);

/** How the latest undo of a step went, or null when it was never undone. */
export function undoText(e: Pick<LogEntryView, 'undoneAt' | 'undoStatus'>): string | null {
  if (e.undoStatus !== null && UNDO_FAILED.has(e.undoStatus)) return 'Undo failed. Try again.';
  if (e.undoneAt === null) return null;
  return e.undoStatus === 'pending' ? 'Undo in progress' : 'Undone';
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ReviewItemView {
  id: string;
  commentId: string;
  source: string;
  ruleName: string | null;
  /** Comment text and author name as posted; render as text only. */
  commentBody: string;
  authorName: string | null;
}

// How often, and how many times, to look again while a step is still pending.
export const POLL_MS = 5000;
export const POLL_LIMIT = 60;

/** A step still running, or an undo still on its way to the platform. */
export const hasPending = (
  entries: readonly { status: StepStatus; undoneAt?: string | null; undoStatus?: string | null }[],
): boolean =>
  entries.some((e) => e.status === 'pending' || (e.undoneAt != null && e.undoStatus === 'pending'));

export type BrandApiBase = `/api/v1/orgs/${string}/brands/${string}`;

export const undoLogStep = (base: BrandApiBase, stepId: string) =>
  apiFetch(`${base}/action-log/${stepId}/undo`, { method: 'POST', body: {} });

export type Resolution = 'approve' | 'hide' | 'delete' | 'ban';
export type ConfirmedResolution = 'delete' | 'ban';

export const needsConfirm = (r: Resolution): r is ConfirmedResolution =>
  r === 'delete' || r === 'ban';

export interface ConfirmDialog {
  itemId: string;
  resolution: ConfirmedResolution;
  /** Made when the dialog opens, so a double click is one request. */
  requestKey: string;
}

export const openConfirm = (itemId: string, resolution: ConfirmedResolution): ConfirmDialog => ({
  itemId,
  resolution,
  requestKey: crypto.randomUUID(),
});

export const resolveReviewItem = (
  base: BrandApiBase,
  itemId: string,
  resolution: Resolution,
  requestKey: string,
) =>
  apiFetch(`${base}/review-items/${itemId}/resolve`, {
    method: 'POST',
    body: { resolution, requestKey, ...(needsConfirm(resolution) && { confirm: true }) },
  });

// A rule's "flag" decision opens the item (source rule); its flag step then owns it.
const SOURCE_LABEL: Record<string, string> = {
  rule: 'Rule',
  action_step: 'Rule',
  user: 'Flagged by a person',
  classifier: 'Classifier',
  policy: 'Policy',
};

export function sourceText(source: string, ruleName: string | null): string {
  const label = Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source]! : 'Flagged';
  return ruleName === null ? label : `${label}: ${ruleName}`;
}
