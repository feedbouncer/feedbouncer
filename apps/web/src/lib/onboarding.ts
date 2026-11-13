import type { PeriodSummary, AccountBreakdown } from '@feedbouncer/reports';

// Mirrors apps/api/src/onboarding/{steps,dto}.ts. Pure and client-safe; the server loader is in onboarding-server.ts.

export const STEPS = ['connect', 'defaults', 'review_mode', 'report'] as const;
export type Step = (typeof STEPS)[number];
export type StepStatuses = Record<Step, 'pending' | 'done'>;

export type WizardConnectionStatus = 'connected' | 'failed' | 'pending';
export type ReviewModeState = 'off' | 'reviewing' | 'ended';

export interface OnboardingConnectionDto {
  id: string;
  platform: string;
  displayName: string | null;
  status: WizardConnectionStatus;
  /** A snake_case code (e.g. oauth_refresh_rejected); mapped to text here. */
  statusReason: string | null;
  reviewMode: ReviewModeState;
  backfill: {
    status: 'pending' | 'running' | 'completed' | 'failed';
    importedCount: number;
  } | null;
}

export interface OnboardingStateDto {
  started: boolean;
  autoStart: boolean;
  preconfigured: boolean;
  dismissed: boolean;
  complete: boolean;
  run: number;
  steps: StepStatuses;
  resumeStep: Step | null;
  reachable: Record<Step, boolean>;
  brand: { id: string; name: string } | null;
  brands: { id: string; name: string }[];
  configuredPlatforms: string[];
  connections: OnboardingConnectionDto[];
  reviewModeChoice: 'review' | 'automatic' | null;
}

export interface OnboardingReportDto {
  range: { from: string; to: string };
  reviewModeChoice: 'review' | 'automatic' | null;
  defaults: { category: string; action: string }[];
  sync: 'no_connections' | 'syncing' | 'ready';
  totals: PeriodSummary['totals'];
  categories: PeriodSummary['categories'];
  accounts: (AccountBreakdown & {
    platform: string;
    displayName: string | null;
    status: WizardConnectionStatus;
    backfill: OnboardingConnectionDto['backfill'];
  })[];
  /** totals.comments === 0. */
  empty: boolean;
}

/** Non-secret cookie that marks an in-progress OAuth round trip as started from the wizard. */
export const ONBOARDING_RETURN_COOKIE = 'fb_onboarding_return';

export function onboardingHref(orgId: string, step?: Step): string {
  return step ? `/orgs/${orgId}/onboarding/${step}` : `/orgs/${orgId}/onboarding`;
}

export function parseStep(v: unknown): Step | null {
  return typeof v === 'string' && (STEPS as readonly string[]).includes(v) ? (v as Step) : null;
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** An error code from a query string is shown only if it is a plain snake_case token. */
export function safeErrorCode(v: unknown): string | null {
  return typeof v === 'string' && ERROR_CODE.test(v) ? v : null;
}

export function isReachable(s: StepStatuses, step: Step): boolean {
  return STEPS.slice(0, STEPS.indexOf(step)).every((earlier) => s[earlier] === 'done');
}
