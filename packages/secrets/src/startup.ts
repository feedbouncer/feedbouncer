import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { Queryable } from './credential-store.js';
import type { Keyring } from './keyring.js';
import { secretsStatus } from './maintenance.js';

/** Boot-time hint for operators. Never blocks startup; logs key ids and counts only. */
export async function reportKeyCoverage(db: Queryable, keys: Keyring, log: Logger): Promise<void> {
  try {
    const s = await secretsStatus(db, keys);
    for (const k of s.keys.filter((x) => !x.configured && x.rows > 0)) {
      log.warn('stored credentials reference an encryption key that is not configured', {
        keyId: k.keyId,
        rows: k.rows,
      });
    }
    if (s.rowsNotOnActiveKey > 0) {
      log.info('credentials pending re-encryption onto the active key', {
        activeKeyId: s.activeKeyId,
        rows: s.rowsNotOnActiveKey,
      });
    }
  } catch (err) {
    log.warn('could not check encryption key coverage', errorFields(err));
  }
}
