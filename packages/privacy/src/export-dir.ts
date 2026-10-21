import { isAbsolute } from 'node:path';
import { EnvError, readString, type Env } from '@feedbouncer/service-runtime';

/** The directory finished exports are written to by the worker and served from by the API. */
export function readExportDir(env: Env): string {
  const dir = readString(env, 'PRIVACY_EXPORT_DIR', {
    fallback: '/var/lib/feedbouncer/privacy-exports',
    maxLength: 4096,
    pattern: /^[^\0]+$/,
  });
  if (!isAbsolute(dir)) throw new EnvError('PRIVACY_EXPORT_DIR must be an absolute path');
  return dir;
}
