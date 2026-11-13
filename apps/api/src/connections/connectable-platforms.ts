import { PLATFORMS, type Platform } from '@feedbouncer/connectors';
import type { AppDeps } from '../deps.js';

/** Registered connectors that let the user pick accounts after consent, in platform order. */
export function connectablePlatforms(deps: AppDeps): Platform[] {
  const registry = deps.connectors?.registry;
  if (!registry) return [];
  return PLATFORMS.filter((p) => registry.get(p)?.capabilities.accountSelection === 'multiple');
}
