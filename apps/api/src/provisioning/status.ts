import { isOrgActive, isUserActive, type OrgStatus, type UserStatus } from '@feedbouncer/db';

/** The status the provisioning API speaks, for organizations and users alike. */
export type ApiStatus = 'active' | 'inactive';

/** Fails closed through the shared rule: anything unrecognized is `inactive`. */
export const orgApiStatus = (raw: unknown): ApiStatus => (isOrgActive(raw) ? 'active' : 'inactive');
export const userApiStatus = (raw: unknown): ApiStatus =>
  isUserActive(raw) ? 'active' : 'inactive';

/** The stored status, the same pair for organizations and users. */
export const fromApiStatus = (s: ApiStatus): OrgStatus & UserStatus =>
  s === 'active' ? 'active' : 'suspended';
