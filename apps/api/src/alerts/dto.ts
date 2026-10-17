import { z } from 'zod';
import type { AlertChannel } from '@feedbouncer/alerts';
import { zUuid } from '../http/validation.js';

const label = z.string().trim().min(1).max(80);

export const SlackCreateBody = z.strictObject({ label, webhookUrl: z.string().max(300) });
export const SlackReconnectBody = z.strictObject({ webhookUrl: z.string().max(300) });
export const EmailCreateBody = z.strictObject({
  email: z.string().max(320),
  label: label.optional(),
});

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const TokenBody = z.strictObject({ token: z.string().regex(TOKEN_RE) });

const Route = z.strictObject({
  alertType: z.enum(['negative_spike', 'flagged_item']),
  channelId: zUuid,
  enabled: z.boolean(),
});

export const BrandAlertsBody = z.strictObject({
  settings: z.strictObject({
    sensitivity: z.enum(['low', 'medium', 'high']),
    minNegativeCount: z.number().int().min(3).max(1000),
    cooldownMinutes: z.number().int().min(30).max(1440),
    contentMode: z.enum(['excerpts', 'counts_only']),
  }),
  routes: z
    .array(Route)
    .max(100)
    .superRefine((routes, ctx) => {
      const seen = new Set<string>();
      for (const [i, r] of routes.entries()) {
        const key = `${r.alertType}:${r.channelId}`;
        if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate route', path: [i] });
        seen.add(key);
      }
    }),
});

/** The channel as the admin pages show it: never a webhook URL or token. */
export interface AlertChannelDto extends Omit<AlertChannel, 'lastFailureAt' | 'createdAt'> {
  lastFailureAt: string | null;
  createdAt: string;
}

export function toChannelDto(c: AlertChannel): AlertChannelDto {
  return {
    ...c,
    lastFailureAt: c.lastFailureAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
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

export interface EventRow {
  id: string;
  alert_type: string;
  status: string;
  created_at: Date;
  window_start: Date | null;
  window_end: Date | null;
  payload: Record<string, unknown>;
  deliveries: { channelId: string; state: string; lastErrorCode: string | null }[];
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function toEventDto(r: EventRow): AlertEventDto {
  const p = r.payload;
  const spike = p.kind === 'spike';
  return {
    id: r.id,
    type: r.alert_type,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    windowStart: r.window_start?.toISOString() ?? null,
    windowEnd: r.window_end?.toISOString() ?? null,
    counts: spike
      ? { negatives: num(p.negatives), total: num(p.total) }
      : p.kind === 'flags'
        ? { items: num(p.count) }
        : {},
    explanation: spike
      ? {
          trigger: String(p.trigger),
          expectedPerHour: num(p.expectedPerHour),
          sensitivity: String(p.sensitivity),
          minCount: num(p.minCount),
        }
      : null,
    deliveries: r.deliveries,
  };
}
