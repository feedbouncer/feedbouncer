export type ChannelKind = 'slack' | 'email';
export type ChannelHealth =
  | 'active'
  | 'delivery_problem'
  | 'disconnected'
  | 'pending_confirmation'
  | 'unsubscribed';
export type AlertType = 'negative_spike' | 'flagged_item';
export type Sensitivity = 'low' | 'medium' | 'high';
export type ContentMode = 'excerpts' | 'counts_only';

export interface Availability {
  slack: boolean;
  email: boolean;
}

/** A channel as the API returns it: never a webhook URL or token. */
export interface AlertChannelDto {
  id: string;
  kind: ChannelKind;
  label: string;
  status: 'pending_confirmation' | 'active' | 'disconnected' | 'unsubscribed';
  health: ChannelHealth;
  hint: string | null;
  email: string | null;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  disconnectedCode: string | null;
  createdAt: string;
}

export interface AlertSettingsDto {
  sensitivity: Sensitivity;
  minNegativeCount: number;
  cooldownMinutes: number;
  contentMode: ContentMode;
}

export interface AlertRouteDto {
  alertType: AlertType;
  channelId: string;
  enabled: boolean;
}

export interface AlertEventDto {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  windowStart: string | null;
  windowEnd: string | null;
  counts: Record<string, number>;
  explanation: {
    trigger: string;
    expectedPerHour: number;
    sensitivity: string;
    minCount: number;
  } | null;
  deliveries: { channelId: string; state: string; lastErrorCode: string | null }[];
}

export interface BrandAlertsView {
  availability: Availability;
  settings: AlertSettingsDto;
  routes: AlertRouteDto[];
  learning: boolean;
  channels: AlertChannelDto[];
  recent: AlertEventDto[];
}

export const ALERT_TYPES: readonly { type: AlertType; label: string }[] = [
  { type: 'negative_spike', label: 'Negative comment spike' },
  { type: 'flagged_item', label: 'Flagged comments' },
];

export const SENSITIVITIES: readonly { value: Sensitivity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium (default)' },
  { value: 'high', label: 'High' },
];

export const COOLDOWNS: readonly { value: number; label: string }[] = [
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
  { value: 180, label: '3 h' },
  { value: 360, label: '6 h (default)' },
  { value: 720, label: '12 h' },
  { value: 1440, label: '24 h' },
];

const ERROR_TEXT: Record<string, string> = {
  no_service: 'Slack no longer accepts this webhook.',
  invalid_token: 'Slack no longer accepts this webhook.',
  no_active_hooks: 'Slack no longer accepts this webhook.',
  channel_is_archived: 'The Slack channel was archived.',
  action_prohibited: 'A Slack admin blocked this webhook.',
  rate_limited: 'Slack is rate limiting messages.',
  outcome_unknown: "Delivery couldn't be confirmed.",
  not_confirmed: "This address hasn't been confirmed yet.",
};

export function errorCodeText(code: string | null): string {
  if (code !== null && Object.hasOwn(ERROR_TEXT, code)) return ERROR_TEXT[code]!;
  return `Delivery failed (${code ?? 'unknown'}).`;
}

export function healthText(
  c: Pick<AlertChannelDto, 'health' | 'lastFailureCode' | 'disconnectedCode'>,
): string {
  switch (c.health) {
    case 'active':
      return 'Active';
    case 'delivery_problem':
      return `Delivery problem: ${errorCodeText(c.lastFailureCode)}`;
    case 'disconnected':
      return `Disconnected: ${errorCodeText(c.disconnectedCode)}`;
    case 'pending_confirmation':
      return 'Waiting for confirmation';
    case 'unsubscribed':
      return 'Unsubscribed';
  }
}

export function alertTypeLabel(type: string): string {
  return ALERT_TYPES.find((t) => t.type === type)?.label ?? type;
}

/** The text shown for a channel: the address for email, the label otherwise. */
export function channelName(c: Pick<AlertChannelDto, 'kind' | 'label' | 'email'>): string {
  return c.kind === 'email' && c.email ? c.email : c.label;
}
