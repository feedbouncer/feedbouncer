import type { CallContext } from '@feedbouncer/connectors';
import type { FacebookConfig } from './config.js';
import type { GraphCall } from './graph.js';

// Graph returns "2026-10-13T09:00:00+0000"; normalize the offset for unambiguous parsing.
export function parseGraphTime(s: string): Date | null {
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(d.getTime()) ? d : null;
}

export const callFor = (cfg: FacebookConfig, nowMs: () => number, ctx: CallContext): GraphCall => ({
  http: ctx.http,
  signal: ctx.signal,
  version: cfg.graphVersion,
  appSecret: cfg.appSecret,
  token: ctx.accessToken,
  nowMs,
});

export async function reporting<T extends { usage: { throttledForMs: number | null } }>(
  ctx: CallContext,
  nowMs: () => number,
  r: T,
): Promise<T> {
  if (r.usage.throttledForMs) {
    await ctx.reportQuota({ remaining: 0, resetAt: new Date(nowMs() + r.usage.throttledForMs) });
  }
  return r;
}
