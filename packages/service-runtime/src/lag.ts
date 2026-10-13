export function clampLag(fromMs: number, toMs: number): { lagMs: number; skewMs: number } {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { lagMs: 0, skewMs: 0 };
  const d = toMs - fromMs;
  return d >= 0 ? { lagMs: d, skewMs: 0 } : { lagMs: 0, skewMs: -d };
}
