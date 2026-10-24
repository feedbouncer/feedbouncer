import { onPermissionDenied, scopeMissing } from '@feedbouncer/tiktok-business-api';

/** Runs `fn`, turning a permission_denied into `scope_missing`: the grant lacks comment management. */
export const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
  onPermissionDenied(fn, () => scopeMissing('comment_management'));
