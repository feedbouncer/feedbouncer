import { isOrgActive, isUserActive } from '@feedbouncer/db';

/** The status the provisioning API speaks, for organizations and users alike. */
export type ApiStatus = 'active' | 'inactive';

/** Fails closed through the shared rule: anything unrecognized is `inactive`. */
export const orgApiStatus = (raw: unknown): ApiStatus => (isOrgActive(raw) ? 'active' : 'inactive');
export const userApiStatus = (raw: unknown): ApiStatus =>
  isUserActive(raw) ? 'active' : 'inactive';
