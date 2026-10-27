import {
  THREADS_REQUIRED_SCOPES,
  THREADS_SCOPES,
  THREADS_SCOPE_PURPOSES,
} from '@feedbouncer/connector-threads';
import type { Platform } from '@feedbouncer/connectors';

export interface ConnectPermission {
  scope: string;
  purpose: string;
  required: boolean;
}

/** What the owner is asked to approve, shown before the connect button. Empty where the platform has no per-feature choice. */
export function connectPermissions(platform: Platform): ConnectPermission[] {
  if (platform !== 'threads') return [];
  const required: readonly string[] = THREADS_REQUIRED_SCOPES;
  return THREADS_SCOPES.map((scope) => ({
    scope,
    purpose: THREADS_SCOPE_PURPOSES[scope],
    required: required.includes(scope),
  }));
}
