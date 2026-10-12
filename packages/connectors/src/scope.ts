import type { ConnectionScope } from '@feedbouncer/secrets';

/** Full tenancy key. Never key per-connection state on `connectionId` alone. */
export const scopeKey = (s: ConnectionScope): string =>
  `${s.organizationId}/${s.brandId}/${s.connectionId}`;
