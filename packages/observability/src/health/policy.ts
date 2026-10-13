import { PLATFORMS, type Platform } from '@feedbouncer/connectors';
import { readInt, type Env } from '@feedbouncer/service-runtime';
import type { HealthPolicy } from './derive.js';

export function loadHealthPolicy(env: Env): HealthPolicy {
  const sec = (name: string, fallback: number, min: number, max: number) =>
    readInt(env, name, { min, max, fallback }) * 1000;
  const stale = sec('CONNECTOR_STALE_AFTER_SECONDS', 3600, 60, 2_592_000);
  const perPlatform = new Map<Platform, number>(
    PLATFORMS.map((p) => [
      p,
      sec(`CONNECTOR_STALE_AFTER_SECONDS_${p.toUpperCase()}`, stale / 1000, 60, 2_592_000),
    ]),
  );
  return {
    staleAfterMs: (p) => perPlatform.get(p) ?? stale,
    lagDegradedMs: sec('CONNECTOR_LAG_DEGRADED_SECONDS', 900, 60, 604_800),
    failuresDegraded: readInt(env, 'CONNECTOR_FAILURES_DEGRADED', {
      min: 1,
      max: 100,
      fallback: 3,
    }),
  };
}
