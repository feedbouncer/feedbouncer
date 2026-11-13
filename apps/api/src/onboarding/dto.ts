import type { ReviewModeState } from '@feedbouncer/connectors';
import type { AccountBreakdown, PeriodSummary } from '@feedbouncer/reports';
import type { ConnectionView } from '../connections/connections.service.js';
import type { Step, StepStatuses } from './steps.js';

export type WizardConnectionStatus = 'connected' | 'failed' | 'pending';

export interface OnboardingConnectionDto {
  id: string;
  platform: string;
  displayName: string | null;
  status: WizardConnectionStatus;
  /** A snake_case code (e.g. oauth_refresh_rejected); the web app maps it to text. */
  statusReason: string | null;
  /** True when the connection's status is needs_reconnect (access lost; reconnecting can fix it). */
  needsReconnect: boolean;
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

/** Expired or revoked authorization stays distinct from other failures through statusReason. */
export function toWizardStatus(v: ConnectionView['status']): WizardConnectionStatus {
  switch (v) {
    case 'connected':
      return 'connected';
    case 'paused':
      return 'pending';
    case 'needs_reconnect':
    case 'error':
    case 'disconnected':
      return 'failed';
  }
}

export function toOnboardingConnection(c: ConnectionView): OnboardingConnectionDto {
  return {
    id: c.id,
    platform: c.platform,
    displayName: c.displayName,
    status: toWizardStatus(c.status),
    statusReason: c.statusReason,
    needsReconnect: c.status === 'needs_reconnect',
    reviewMode: c.reviewMode.state,
    backfill: c.backfill && { status: c.backfill.status, importedCount: c.backfill.importedCount },
  };
}

export type DefaultAction = 'hide' | 'flag' | 'approve';

export interface DefaultCategoryDto {
  category: string;
  action: 'hide' | 'flag' | 'approve' | 'remove';
  threshold: number;
  source: 'default' | 'brand';
}

export interface OnboardingDefaultsDto {
  aiEnabled: boolean;
  categories: DefaultCategoryDto[];
  /** Fingerprint of `categories`; PUT must echo it so a stale view cannot overwrite newer settings. */
  basedOn: string;
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
