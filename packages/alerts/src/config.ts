import { EnvError, readInt, type Env } from '@feedbouncer/service-runtime';

const CHANNELS = ['slack', 'email'] as const;

export interface AlertChannelsEnabled {
  slack: boolean;
  email: boolean;
}

export function parseAlertChannels(raw: string | undefined): AlertChannelsEnabled {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((t) => !(CHANNELS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new EnvError(`ALERT_CHANNELS must be a comma list of ${CHANNELS.join(', ')}`);
  }
  return { slack: tokens.includes('slack'), email: tokens.includes('email') };
}

export function readAlertLimits(env: Env): { capPerHour: number; emailPerMinute: number } {
  return {
    capPerHour: readInt(env, 'ALERT_MAX_PER_WORKSPACE_PER_HOUR', {
      min: 1,
      max: 1000,
      fallback: 30,
    }),
    emailPerMinute: readInt(env, 'ALERT_EMAIL_MAX_PER_MINUTE', {
      min: 1,
      max: 6000,
      fallback: 60,
    }),
  };
}
