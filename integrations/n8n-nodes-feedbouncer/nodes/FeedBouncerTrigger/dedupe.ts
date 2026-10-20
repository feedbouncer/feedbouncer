import { DEDUPE_MAX_IDS, DEDUPE_TTL_MS } from '../shared/constants';
import type { TriggerStaticData } from './lifecycle';

/** Records an event id. Returns false when it was already seen. */
export function rememberEvent(staticData: TriggerStaticData, eventId: string, nowMs: number): boolean {
  const seen: Record<string, number> = Object.create(null);
  for (const [id, at] of Object.entries(staticData.seen ?? {})) {
    if (nowMs - at <= DEDUPE_TTL_MS) seen[id] = at;
  }
  staticData.seen = seen;
  if (eventId in seen) return false;

  seen[eventId] = nowMs;
  const ids = Object.keys(seen);
  if (ids.length > DEDUPE_MAX_IDS) {
    ids.sort((a, b) => seen[a] - seen[b]);
    for (const id of ids.slice(0, ids.length - DEDUPE_MAX_IDS)) delete seen[id];
  }
  return true;
}
